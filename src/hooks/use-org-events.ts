"use client";

import { useEffect, useRef } from "react";

/** What `/api/org/events` sends. Ids only; content is refetched. */
export type OrgClientEvent =
    | { type: "tree" }
    | { type: "recording"; recordingId: string };

function parseEvent(data: string): OrgClientEvent | null {
    try {
        const value = JSON.parse(data) as Record<string, unknown>;
        if (value.type === "tree") return { type: "tree" };
        if (
            value.type === "recording" &&
            typeof value.recordingId === "string"
        ) {
            return { type: "recording", recordingId: value.recordingId };
        }
    } catch {
        // A malformed frame is dropped; the next one still arrives.
    }
    return null;
}

/**
 * Follow Organization changes made by other people.
 *
 * `EventSource` reconnects by itself after a dropped connection or a server
 * restart, so this holds no retry logic of its own.
 */
export function useOrgEvents(
    enabled: boolean,
    onEvent: (event: OrgClientEvent) => void,
): void {
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;

    useEffect(() => {
        if (!enabled || typeof EventSource === "undefined") return;
        const source = new EventSource("/api/org/events");
        source.onmessage = (message) => {
            const event = parseEvent(message.data);
            if (event) onEventRef.current(event);
        };
        return () => source.close();
    }, [enabled]);
}
