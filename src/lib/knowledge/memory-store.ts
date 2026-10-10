/**
 * Knowledge held in memory, per scope, per process: the decrypted names,
 * aliases, heard-as forms, notes and facts a scope knows, loaded lazily and
 * searched without the database.
 *
 * Correctness never depends on a notification. Every transaction that
 * changes a scope moves its generation (`scope-generation.ts`); each run,
 * and each tool call, reads the generations of the scopes it uses in one
 * query and reloads a scope whose generation moved. A scope whose
 * generation went back to none (its account is gone) is dropped. A
 * notification only marks a scope stale sooner, and a lost listener drops
 * everything. A scope older than a floor is reloaded anyway, which bounds
 * how long a change missed by mistake could show.
 *
 * Memory is bounded: least recently used scopes are evicted past a byte
 * limit, the Organization's last, since every run reads it.
 *
 * Pure: the loader and the generation reader are given, so it runs without
 * a database (`knowledge-loader.ts` gives the real ones).
 */

import type { KnowledgeTarget } from "@/lib/knowledge/aliases";
import { type NameCandidate, NameIndex } from "@/lib/knowledge/name-match";
import type { VectorMatrix } from "@/lib/knowledge/vector-search";

export interface KnownItem {
    id: string;
    kind: "person" | "entity";
    /** The entity's type; `person` for people. */
    typeKey: string;
    name: string;
    description: string | null;
}

export interface KnownName {
    target: KnowledgeTarget;
    kind: "alias" | "heard_as";
    text: string;
    language: string | null;
    provider: string | null;
}

export interface KnownFact {
    id: string;
    subject: KnowledgeTarget;
    relationKey: string;
    object: KnowledgeTarget | { literal: string };
    origin: "recording" | "mail" | "manual";
}

/** What one scope knows, as loaded. */
export interface LoadedScope {
    /** The people and entities the scope owns. */
    items: KnownItem[];
    /** The scope's aliases and heard-as forms, on its own or others' items. */
    names: KnownName[];
    /** The scope's notes on others' items (the Organization's), by id. */
    notes: Map<string, string>;
    /** Its current facts, shown and used. */
    facts: KnownFact[];
    /** Its vectors of the generation searched; null without any. */
    vectors?: VectorMatrix | null;
}

export interface ScopeKnowledge extends LoadedScope {
    scope: string;
    generation: number;
    loadedAt: number;
    /** Its items' names and its names on any item, ready to search. */
    index: NameIndex;
    /** An estimate of the memory it holds. */
    bytes: number;
}

export interface MemoryStoreStats {
    scopes: number;
    bytes: number;
    hits: number;
    loads: number;
    evictions: number;
    dropped: number;
}

export interface MemoryStoreOptions {
    load: (scope: string) => Promise<LoadedScope>;
    readGenerations: (
        scopes: readonly string[],
    ) => Promise<Map<string, number>>;
    maxBytes: number;
    /** Reload a scope older than this, whatever its generation says. */
    ttlMs?: number;
    /** The scope evicted last (the Organization's). */
    pinnedScope?: () => string | null;
    now?: () => number;
    log?: (message: string) => void;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const ITEM_OVERHEAD = 64;

function textBytes(value: string | null | undefined): number {
    return value ? value.length * 2 : 0;
}

/** The names a scope's index holds: its items', and its names on any item. */
function nameCandidates(loaded: LoadedScope): NameCandidate[] {
    return [
        ...loaded.items.map((item) => ({ id: item.id, names: [item.name] })),
        ...loaded.names.map((name) => ({
            id:
                "personId" in name.target
                    ? name.target.personId
                    : name.target.entityId,
            names: [name.text],
        })),
    ];
}

/** An estimate of what a loaded scope holds in memory, before its index. */
export function estimateBytes(loaded: LoadedScope): number {
    let bytes = 0;
    for (const item of loaded.items) {
        bytes +=
            ITEM_OVERHEAD +
            textBytes(item.id) +
            textBytes(item.name) +
            textBytes(item.description) +
            textBytes(item.typeKey);
    }
    for (const name of loaded.names) {
        bytes += ITEM_OVERHEAD + textBytes(name.text) + 48;
    }
    for (const [id, notes] of loaded.notes) {
        bytes += ITEM_OVERHEAD + textBytes(id) + textBytes(notes);
    }
    bytes += loaded.vectors?.data.byteLength ?? 0;
    for (const fact of loaded.facts) {
        bytes +=
            ITEM_OVERHEAD * 2 +
            textBytes(fact.id) +
            textBytes(fact.relationKey) +
            ("literal" in fact.object ? textBytes(fact.object.literal) : 24);
    }
    return bytes;
}

export class KnowledgeMemoryStore {
    private readonly cached = new Map<string, ScopeKnowledge>();
    private readonly loading = new Map<
        string,
        { generation: number; sequence: number; load: Promise<ScopeKnowledge> }
    >();
    /** Per scope, the number of the last load kept, or of a drop. */
    private readonly settled = new Map<string, number>();
    private sequence = 0;
    private readonly stale = new Set<string>();
    private totalBytes = 0;
    private readonly counts = { hits: 0, loads: 0, evictions: 0, dropped: 0 };

    constructor(private readonly options: MemoryStoreOptions) {}

    /**
     * The knowledge of `scopes`, fresh: their generations are read in one
     * query, and a scope that moved, is stale or old is reloaded first.
     */
    async get(scopes: readonly string[]): Promise<ScopeKnowledge[]> {
        const unique = [...new Set(scopes)];
        const generations = await this.options.readGenerations(unique);
        const now = this.now();
        const ttl = this.options.ttlMs ?? DEFAULT_TTL_MS;
        const result = await Promise.all(
            unique.map(async (scope) => {
                const generation = generations.get(scope) ?? 0;
                const held = this.cached.get(scope);
                if (held && generation === 0 && held.generation > 0) {
                    // Its account is gone, and so is everything it knew.
                    this.drop(scope);
                    this.counts.dropped++;
                }
                const current = this.cached.get(scope);
                if (
                    current &&
                    current.generation === generation &&
                    !this.stale.has(scope) &&
                    now - current.loadedAt < ttl
                ) {
                    this.counts.hits++;
                    this.touch(scope, current);
                    return current;
                }
                return this.reload(scope, generation);
            }),
        );
        this.evict(new Set(unique));
        return result;
    }

    /** A notification said the scope changed: reload it on its next use. */
    markStale(scope: string): void {
        if (this.cached.has(scope)) this.stale.add(scope);
    }

    /**
     * Forget everything: the listener that would have said what changed was
     * lost. Loads in flight are fenced too, so none of them is kept.
     */
    invalidateAll(): void {
        for (const scope of [
            ...new Set([...this.cached.keys(), ...this.loading.keys()]),
        ]) {
            this.drop(scope);
        }
        this.stale.clear();
    }

    stats(): MemoryStoreStats {
        return {
            scopes: this.cached.size,
            bytes: this.totalBytes,
            ...this.counts,
        };
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    private touch(scope: string, entry: ScopeKnowledge): void {
        this.cached.delete(scope);
        this.cached.set(scope, entry);
    }

    /** Forget a scope, and every load of it already in flight. */
    private drop(scope: string): void {
        this.settled.set(scope, ++this.sequence);
        this.remove(scope);
    }

    private remove(scope: string): void {
        const held = this.cached.get(scope);
        if (!held) return;
        this.totalBytes -= held.bytes;
        this.cached.delete(scope);
        this.stale.delete(scope);
    }

    /**
     * Load a scope once however many ask at the same time, as long as the
     * load in flight was started for at least the generation this caller
     * read: one started for an older generation may miss what moved it, so
     * a newer need starts its own. Loads are numbered, and one finishing
     * after a later load stored (or after the scope was dropped) returns to
     * its own callers but is not kept.
     */
    private reload(scope: string, generation: number): Promise<ScopeKnowledge> {
        const pending = this.loading.get(scope);
        // Joinable: started for at least this generation, and not fenced
        // by a drop since (a load from before the account went, or before
        // everything was forgotten, may hold what is gone).
        if (
            pending &&
            pending.generation >= generation &&
            pending.sequence > (this.settled.get(scope) ?? 0)
        ) {
            return pending.load;
        }
        const sequence = ++this.sequence;
        const load = (async () => {
            try {
                const loaded = await this.options.load(scope);
                const index = new NameIndex(nameCandidates(loaded));
                const entry: ScopeKnowledge = {
                    ...loaded,
                    scope,
                    generation,
                    loadedAt: this.now(),
                    index,
                    bytes: estimateBytes(loaded) + index.bytes,
                };
                this.counts.loads++;
                if ((this.settled.get(scope) ?? 0) > sequence) return entry;
                this.remove(scope);
                this.cached.set(scope, entry);
                this.totalBytes += entry.bytes;
                this.settled.set(scope, sequence);
                return entry;
            } finally {
                if (this.loading.get(scope)?.sequence === sequence) {
                    this.loading.delete(scope);
                }
            }
        })();
        this.loading.set(scope, { generation, sequence, load });
        return load;
    }

    /**
     * Evict least recently used scopes past the byte limit, never one this
     * call returns, and the pinned one only when nothing else is left.
     */
    private evict(inUse: ReadonlySet<string>): void {
        if (this.totalBytes <= this.options.maxBytes) return;
        const pinned = this.options.pinnedScope?.() ?? null;
        const order = [...this.cached.keys()].filter(
            (scope) => !inUse.has(scope),
        );
        const candidates = [
            ...order.filter((scope) => scope !== pinned),
            ...order.filter((scope) => scope === pinned),
        ];
        for (const scope of candidates) {
            if (this.totalBytes <= this.options.maxBytes) break;
            const bytes = this.cached.get(scope)?.bytes ?? 0;
            this.remove(scope);
            this.counts.evictions++;
            this.options.log?.(
                `[knowledge] evicted a scope (${bytes} bytes); ${this.cached.size} held, ${this.totalBytes} bytes`,
            );
        }
    }
}
