import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { getOrgUserId } from "@/lib/org/config";
import { type OrgEvent, subscribeOrgEvents } from "@/lib/org/events";

export const dynamic = "force-dynamic";

/** Keep-alive cadence, well inside a typical proxy idle timeout. */
const KEEPALIVE_MS = 25_000;

/**
 * `GET /api/org/events` -- Organization invalidations as Server-Sent Events.
 *
 * Every tab of every account holds one of these. Events carry ids only; the
 * client refetches through the ordinary access-checked routes, so nothing
 * here needs to be filtered per viewer.
 */
export const GET = apiHandler(async (request: Request) => {
    await requireApiSession(request);
    if (!(await getOrgUserId())) {
        throw new AppError(ErrorCode.NOT_FOUND, "Not found", 404);
    }

    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream({
        start(controller) {
            let closed = false;
            const write = (chunk: string) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    closed = true;
                    cleanup();
                }
            };
            const unsubscribe = subscribeOrgEvents((event: OrgEvent) => {
                write(`data: ${JSON.stringify(event)}\n\n`);
            });
            const keepalive = setInterval(
                () => write(": keep-alive\n\n"),
                KEEPALIVE_MS,
            );
            cleanup = () => {
                closed = true;
                clearInterval(keepalive);
                unsubscribe();
                try {
                    controller.close();
                } catch {
                    // Already closed by the client.
                }
            };
            request.signal.addEventListener("abort", () => cleanup());
            write(": connected\n\n");
        },
        cancel() {
            cleanup();
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
});
