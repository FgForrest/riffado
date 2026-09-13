/**
 * The map from `async_jobs.kind` to the code that runs it.
 *
 * A registry rather than a switch in the worker so that a kind lives entirely
 * in its own module -- the summary handler sits next to the summary code it
 * calls, not inside a growing dispatcher that imports every feature in the
 * app (and drags all of them into any test that touches the worker).
 */

import type { JobHandler } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: handlers are heterogeneous in their payload type by design; `getJobHandler` hands back an opaque handler and the worker only ever passes it a payload it produced via that same handler's `parsePayload`.
const handlers = new Map<string, JobHandler<any>>();

/**
 * Register a handler. Registering the same kind twice replaces the previous
 * one rather than throwing: the dev server re-evaluates modules on hot reload,
 * and a startup crash there would be a worse outcome than the last definition
 * winning.
 */
export function registerJobHandler<P>(handler: JobHandler<P>): void {
    if (handler.kind.length > 64) {
        throw new Error(
            `Job kind "${handler.kind}" exceeds the 64-character column limit`,
        );
    }
    handlers.set(handler.kind, handler);
}

// biome-ignore lint/suspicious/noExplicitAny: see the note on `handlers`.
export function getJobHandler(kind: string): JobHandler<any> | undefined {
    return handlers.get(kind);
}

// biome-ignore lint/suspicious/noExplicitAny: see the note on `handlers`.
export function listJobHandlers(): JobHandler<any>[] {
    return [...handlers.values()];
}

/** Test seam. Never called in production code. */
export function clearJobHandlers(): void {
    handlers.clear();
}
