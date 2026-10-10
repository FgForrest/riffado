import { and, desc, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
    type ChatterItemKind,
    chatterItems,
    mailContents,
    mailParticipants,
    transcriptions,
} from "@/db/schema";
import type { ContentSegment } from "@/lib/content/types";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { secretAddressMasker } from "@/lib/mail/redact";
import { decodeKeyset, encodeKeyset } from "@/lib/mcp/cursor";
import { boundedScan } from "@/lib/mcp/scan";
import { getOrgUserId } from "@/lib/org/config";
import { sharedItemCondition } from "@/lib/sharing/shared";
import type { RecordingView } from "@/lib/sharing/view";

const BATCH = 50;
const SCAN_LIMIT = 1_000;
const DEADLINE_MS = 5_000;
const MAX_RESULTS = 100;
const SNIPPET_CHARS = 140;

/** An item a search found, with a few of its words around the match. */
export interface ItemSearchHit {
    id: string;
    kind: ChatterItemKind;
    snippet: string | null;
}

export interface ItemSearchResult {
    hits: ItemSearchHit[];
    scanned: number;
    /** The search reached the oldest item. */
    complete: boolean;
    /** Pass back as `before` to search further back. */
    continueBefore: string | null;
}

interface LoadedItem {
    id: string;
    userId: string;
    kind: ChatterItemKind;
    occurredAt: Date;
    title: string;
    /** What the item says that a search reads, in reading order. */
    texts: string[];
}

/** Lowercase, without accents: "Příliš" and "prilis" are one word. */
export function foldForSearch(text: string): string {
    return text
        .normalize("NFKD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();
}

/**
 * What a mail says itself: its own text, never what it quotes, its
 * signature or its disclaimer (those find every mail of a thread or a
 * sender), and no part already in the pile as another item.
 */
function ownText(segments: readonly ContentSegment[]): string[] {
    return segments
        .filter((segment) => segment.role === "body" && !segment.knownItemId)
        .map((segment) => segment.text);
}

function snippetOf(texts: readonly string[], word: string): string | null {
    for (const text of texts) {
        const at = foldForSearch(text).indexOf(word);
        if (at < 0) continue;
        const start = Math.max(0, at - SNIPPET_CHARS / 3);
        const piece = text
            .slice(start, start + SNIPPET_CHARS)
            .replace(/\s+/g, " ")
            .trim();
        return `${start > 0 ? "…" : ""}${piece}${
            start + SNIPPET_CHARS < text.length ? "…" : ""
        }`;
    }
    return null;
}

/**
 * Items newest first after `before`, with what each says: a recording's
 * transcripts (every one its owner holds), a mail's own text and sender.
 * `occurred_at` is written from JavaScript dates, so millisecond cursors
 * compare exactly against the column, and its index serves the order.
 */
async function loadBatch(
    scope: SQL,
    before: string | null,
): Promise<LoadedItem[]> {
    const after = before ? decodeKeyset(before) : null;
    const rows = await db
        .select({
            id: chatterItems.id,
            userId: chatterItems.userId,
            kind: chatterItems.kind,
            occurredAt: chatterItems.occurredAt,
            title: chatterItems.title,
        })
        .from(chatterItems)
        .where(
            and(
                scope,
                isNull(chatterItems.deletedAt),
                after
                    ? or(
                          lt(chatterItems.occurredAt, after.at),
                          and(
                              eq(chatterItems.occurredAt, after.at),
                              lt(chatterItems.id, after.id),
                          ),
                      )
                    : undefined,
            ),
        )
        .orderBy(desc(chatterItems.occurredAt), desc(chatterItems.id))
        .limit(BATCH);
    if (rows.length === 0) return [];
    const ownerOf = new Map(rows.map((row) => [row.id, row.userId]));
    const mailIds = rows.filter((row) => row.kind === "mail").map((r) => r.id);
    const audioIds = rows
        .filter((row) => row.kind === "audio")
        .map((r) => r.id);
    const [contents, senders, transcripts] = await Promise.all([
        mailIds.length > 0
            ? db
                  .select({
                      itemId: mailContents.itemId,
                      userId: mailContents.userId,
                      segments: mailContents.segments,
                  })
                  .from(mailContents)
                  .where(inArray(mailContents.itemId, mailIds))
            : [],
        mailIds.length > 0
            ? db
                  .select({
                      itemId: mailParticipants.itemId,
                      userId: mailParticipants.userId,
                      roles: mailParticipants.roles,
                      name: mailParticipants.name,
                      address: mailParticipants.address,
                  })
                  .from(mailParticipants)
                  .where(inArray(mailParticipants.itemId, mailIds))
            : [],
        audioIds.length > 0
            ? db
                  .select({
                      itemId: transcriptions.recordingId,
                      userId: transcriptions.userId,
                      text: transcriptions.text,
                  })
                  .from(transcriptions)
                  .where(inArray(transcriptions.recordingId, audioIds))
            : [],
    ]);
    const texts = new Map<string, string[]>();
    const add = (itemId: string, userId: string, values: string[]) => {
        // The owner's rows alone: a shared item is one item.
        if (ownerOf.get(itemId) !== userId) return;
        texts.set(itemId, [...(texts.get(itemId) ?? []), ...values]);
    };
    for (const row of senders) {
        if (!row.roles.includes("from")) continue;
        add(row.itemId, row.userId, [
            ...(row.name ? [decryptText(row.name)] : []),
            ...(row.address ? [decryptText(row.address)] : []),
        ]);
    }
    for (const row of contents) {
        add(
            row.itemId,
            row.userId,
            ownText(decryptJsonField<ContentSegment[]>(row.segments) ?? []),
        );
    }
    for (const row of transcripts) {
        add(row.itemId, row.userId, [decryptText(row.text)]);
    }
    return rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        kind: row.kind,
        occurredAt: row.occurredAt,
        title: decryptText(row.title),
        texts: texts.get(row.id) ?? [],
    }));
}

/**
 * Search the items of one library for every word of `query` (case and
 * accents ignored): `private`, the viewer's own; `org`, those shared into
 * the Organization. Titles, a mail's sender and its own text, and a
 * recording's transcripts are read; everything is encrypted, so the
 * search decrypts newest first and stops at a bound, saying where to go
 * on. A mail of someone else's has its secret addresses masked.
 */
export async function searchItems({
    viewerUserId,
    view,
    query,
    before = null,
}: {
    viewerUserId: string;
    view: RecordingView;
    query: string;
    before?: string | null;
}): Promise<ItemSearchResult> {
    const words = foldForSearch(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) {
        return { hits: [], scanned: 0, complete: true, continueBefore: null };
    }
    let scope: SQL;
    if (view === "org") {
        const orgUserId = await getOrgUserId();
        if (!orgUserId) {
            return {
                hits: [],
                scanned: 0,
                complete: true,
                continueBefore: null,
            };
        }
        scope = sharedItemCondition(orgUserId, chatterItems.id);
    } else {
        scope = eq(chatterItems.userId, viewerUserId);
    }
    const found: (ItemSearchHit & { ownerUserId: string })[] = [];
    const scan = await boundedScan({
        batches: (stamp) => loadBatch(scope, stamp),
        stampOf: (item) => encodeKeyset({ at: item.occurredAt, id: item.id }),
        visit: (item) => {
            const all = [item.title, ...item.texts];
            const folded = foldForSearch(all.join("\n"));
            if (!words.every((word) => folded.includes(word))) return null;
            const snippet = foldForSearch(item.title).includes(words[0] ?? "")
                ? null
                : snippetOf(item.texts, words[0] ?? "");
            found.push({
                id: item.id,
                kind: item.kind,
                snippet,
                ownerUserId: item.userId,
            });
            return item.id;
        },
        limit: SCAN_LIMIT,
        deadlineMs: DEADLINE_MS,
        maxResults: MAX_RESULTS,
        before,
    });
    const foreignMail = found.filter(
        (hit) =>
            hit.kind === "mail" &&
            hit.snippet &&
            hit.ownerUserId !== viewerUserId,
    );
    const mask =
        foreignMail.length > 0
            ? await secretAddressMasker(
                  foreignMail.map((hit) => hit.snippet ?? ""),
              )
            : (text: string) => text;
    return {
        hits: found.map(({ ownerUserId, ...hit }) => ({
            ...hit,
            snippet:
                hit.snippet &&
                hit.kind === "mail" &&
                ownerUserId !== viewerUserId
                    ? mask(hit.snippet)
                    : hit.snippet,
        })),
        scanned: scan.scanned,
        complete: scan.complete,
        continueBefore: scan.continueBefore,
    };
}
