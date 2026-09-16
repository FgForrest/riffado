/**
 * Server-sent-event wire format for streaming summary progress.
 *
 * Lives apart from `generate-summary.ts` because the browser imports it: that
 * module pulls in the database and the OpenAI client, neither of which belongs
 * in a client bundle. Everything here is pure, which also makes the chunk
 * handling -- the only genuinely fiddly part -- unit-testable.
 */

import type { MultiPassPhase, MultiPassProvenance } from "./multi-pass";

/** The summary payload, shaped as the client consumes it. */
export interface SummaryStreamResult {
    summary: string;
    keyPoints: string[];
    actionItems: string[];
    source?: "plaud" | "riffado";
    transcriptionId?: string | null;
    provider?: string;
    model?: string;
    promptId?: string;
    promptFallback?: boolean;
    multiPass?: MultiPassProvenance;
}

export type SummaryStreamEvent =
    /**
     * Sent first, before any work is reported.
     *
     * Generation runs on a worker, so the summary outlives the request that
     * asked for it. Handing the client the job id up front is what lets a
     * stream broken by a closed laptop, a proxy timeout or a container
     * upgrade be resumed by polling instead of reported as a failure -- the
     * work is still happening, and before this the client had no way to say
     * so.
     */
    | { type: "queued"; jobId: string }
    | {
          type: "progress";
          phase: MultiPassPhase;
          completed: number;
          total: number;
      }
    | { type: "result"; result: SummaryStreamResult }
    /**
     * Failures arrive as an event, not a status code. Once the first byte of a
     * stream is sent the status is already 200, so a late failure cannot be
     * expressed as a 4xx/5xx -- the client has to read this instead of
     * trusting `response.ok`.
     */
    | { type: "error"; error: string; code?: string };

export function encodeStreamEvent(event: SummaryStreamEvent): string {
    return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Build a stateful parser for a byte stream of these events.
 *
 * A `data:` frame is not guaranteed to arrive whole: one read can split a
 * frame down the middle, or deliver three at once. The parser keeps a buffer
 * and only emits on a complete `\n\n` terminator, so neither case loses or
 * duplicates an event.
 *
 * Unparseable frames are skipped rather than thrown: a malformed line is not
 * worth failing a summary that has otherwise succeeded.
 */
export function createStreamEventParser(): (
    chunk: string,
) => SummaryStreamEvent[] {
    let buffer = "";
    return (chunk: string) => {
        buffer += chunk;
        const events: SummaryStreamEvent[] = [];
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of frame.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (!payload) continue;
                try {
                    events.push(JSON.parse(payload) as SummaryStreamEvent);
                } catch {
                    // Skip the frame; see the doc comment.
                }
            }
            boundary = buffer.indexOf("\n\n");
        }
        return events;
    };
}

/** `0:07`, `1:12`, `12:05`. */
export function formatElapsed(elapsedMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface SummaryStatusProgress {
    phase: MultiPassPhase;
    completed: number;
    total: number;
}

/**
 * The line shown while a summary is generating.
 *
 * The elapsed clock is the part that matters most, and it is deliberately
 * shown even on the single-pass path, which reports no progress at all: a
 * spinner with no movement is indistinguishable from a hung request, which is
 * exactly how a slow multi-pass run was first reported.
 */
export function formatSummaryStatus(
    progress: SummaryStatusProgress | null | undefined,
    elapsedMs: number,
): string {
    let label: string;
    if (!progress) {
        label = "Generating summary…";
    } else if (progress.phase === "merging") {
        label = `Merging ${progress.total} passes…`;
    } else {
        label = `Summarizing — ${progress.completed}/${progress.total} passes`;
    }
    return elapsedMs > 0 ? `${label} · ${formatElapsed(elapsedMs)}` : label;
}
