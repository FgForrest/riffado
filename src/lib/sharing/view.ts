/**
 * Which set of content rows a request reads and writes.
 *
 * `private` is the owner's own transcript and summary. `org` is the
 * Organization view of a shared recording: rows owned by the organization
 * account, falling back to the owner's rows until someone produces its own.
 *
 * Dependency-free so client components and the light job-queueing modules
 * can import it.
 */
export type RecordingView = "private" | "org";

/** Job subject for a recording in a view; Organization jobs dedupe separately. */
export function recordingJobSubject(
    recordingId: string,
    view: RecordingView,
): string {
    return view === "org" ? `org:${recordingId}` : recordingId;
}

/** Append `view=org` to a recording API path when the view is Organization. */
export function withRecordingView(
    path: string,
    view: RecordingView | undefined,
): string {
    if (view !== "org") return path;
    return `${path}${path.includes("?") ? "&" : "?"}view=org`;
}
