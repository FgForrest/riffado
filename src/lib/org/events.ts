import { EventEmitter } from "node:events";
import { sql } from "drizzle-orm";
import { db, sqlClient } from "@/db";

/**
 * Invalidation events for the Organization scope.
 *
 * Ids only. Every client that receives one refetches through the normal,
 * access-checked routes, so an event never carries content and never needs
 * to be filtered per viewer.
 */
export type OrgEvent =
    | { type: "tree" }
    | { type: "recording"; recordingId: string };

const CHANNEL = "riffado_org";

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let listening: Promise<unknown> | null = null;

function parseEvent(payload: string): OrgEvent | null {
    try {
        const value = JSON.parse(payload) as Record<string, unknown>;
        if (value.type === "tree") return { type: "tree" };
        if (
            value.type === "recording" &&
            typeof value.recordingId === "string"
        ) {
            return { type: "recording", recordingId: value.recordingId };
        }
    } catch {
        // Not ours, or truncated. Ignored rather than crashing the listener.
    }
    return null;
}

/**
 * Tell every app process that something in the Organization scope changed.
 *
 * Best effort: a lost notification only means a client refreshes on its
 * next navigation instead of at once, so a failure here never fails the
 * mutation that caused it.
 */
export async function notifyOrgChange(event: OrgEvent): Promise<void> {
    try {
        await db.execute(
            sql`select pg_notify(${CHANNEL}, ${JSON.stringify(event)})`,
        );
    } catch (error) {
        console.error("[org-events] notify failed:", error);
    }
}

function ensureListening(): void {
    if (listening || !sqlClient) return;
    listening = sqlClient
        .listen(CHANNEL, (payload) => {
            const event = parseEvent(payload);
            if (event) emitter.emit("event", event);
        })
        .catch((error: unknown) => {
            console.error("[org-events] listen failed:", error);
            listening = null;
        });
}

/** Receive Organization events from every process. Returns an unsubscribe. */
export function subscribeOrgEvents(
    listener: (event: OrgEvent) => void,
): () => void {
    ensureListening();
    emitter.on("event", listener);
    return () => {
        emitter.off("event", listener);
    };
}
