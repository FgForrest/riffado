import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiEnhancements, recordings } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { DEMO_SUMMARIES, isDemoRecordingId } from "@/lib/demo/fixtures";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import {
    AppError,
    apiHandler,
    ErrorCode,
    mapErrorToAppError,
} from "@/lib/errors";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import {
    encodeStreamEvent,
    type SummaryStreamEvent,
} from "@/lib/summary/progress-stream";

type IdContext = { params: Promise<{ id: string }> };

export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);

    const { id } = await (context as IdContext).params;
    const body = await request.json().catch(() => ({}));
    const presetId = (body.preset as string) || undefined;

    // The JSON path stays the default. Only a caller that asks for the event
    // stream gets one, so the auto-summarize path, the API tests and any
    // client that predates streaming keep the response they expect.
    const accept = request.headers.get("accept") ?? "";
    if (!accept.includes("text/event-stream")) {
        const result = await generateSummaryForRecording(session.user.id, id, {
            presetId,
            trigger: "manual",
        });
        return NextResponse.json(result);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            const send = (event: SummaryStreamEvent) => {
                try {
                    controller.enqueue(
                        encoder.encode(encodeStreamEvent(event)),
                    );
                } catch {
                    // The client hung up. Generation deliberately continues:
                    // the summary is persisted server-side either way, so
                    // abandoning it here would waste the passes already paid
                    // for and leave the recording without a summary.
                }
            };

            try {
                const result = await generateSummaryForRecording(
                    session.user.id,
                    id,
                    {
                        presetId,
                        trigger: "manual",
                        onProgress: (progress) =>
                            send({ type: "progress", ...progress }),
                    },
                );
                send({ type: "result", result });
            } catch (error) {
                // Status is already 200 by the time anything can fail here, so
                // the failure has to travel as an event. `mapErrorToAppError`
                // keeps the message identical to the JSON path's.
                const mapped = mapErrorToAppError(error);
                send({
                    type: "error",
                    error: mapped.message,
                    code: mapped.code,
                });
            } finally {
                try {
                    controller.close();
                } catch {
                    // Already closed by a client disconnect.
                }
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            // `no-transform` and `X-Accel-Buffering` stop an intermediate
            // proxy from buffering the stream into one chunk at the end,
            // which would deliver every progress event at once, after the
            // work they describe had already finished.
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
});

// GET - Fetch existing summary
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);

    const { id } = await (context as IdContext).params;

    // Dev-only short-circuit for the `/dev/demo-dashboard` screenshot
    // route. Two gates -- `NODE_ENV !== production` AND a `demo-` id
    // prefix -- so this branch is literally unreachable in production
    // builds even if a caller invents a `demo-*` id. Never touches the
    // DB, never decrypts, never logs PII. See `src/lib/demo/fixtures.ts`.
    if (process.env.NODE_ENV !== "production" && isDemoRecordingId(id)) {
        const fixture = DEMO_SUMMARIES.get(id);
        if (!fixture) {
            return NextResponse.json({ summary: null });
        }
        return NextResponse.json({
            summary: fixture.summary,
            keyPoints: fixture.keyPoints,
            actionItems: fixture.actionItems,
            provider: fixture.provider,
            model: fixture.model,
        });
    }

    const [recording] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, session.user.id),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);

    if (!recording) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }

    const [enhancement] = await db
        .select()
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.recordingId, id),
                eq(aiEnhancements.userId, session.user.id),
            ),
        )
        .limit(1);

    if (!enhancement) {
        return NextResponse.json({ summary: null });
    }

    // Decrypt content fields before returning to the client. Legacy
    // plaintext rows pass through verbatim during the backfill window.
    return NextResponse.json({
        summary: decryptText(enhancement.summary),
        keyPoints: decryptJsonField<string[]>(enhancement.keyPoints),
        actionItems: decryptJsonField<string[]>(enhancement.actionItems),
        provider: enhancement.provider,
        model: enhancement.model,
        // Same nested shape the POST returns, so the client has one shape to
        // render rather than flat columns here and an object there.
        multiPass:
            enhancement.multiPassRounds == null
                ? undefined
                : {
                      roundsRequested: enhancement.multiPassRounds,
                      passesUsed: enhancement.multiPassUsed ?? 0,
                      merged: enhancement.multiPassMerged ?? false,
                  },
        createdAt: enhancement.createdAt,
    });
});

// DELETE - Remove summary
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);

    const { id } = await (context as IdContext).params;

    await db.transaction(async (tx) => {
        const deleted = await tx
            .delete(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.recordingId, id),
                    eq(aiEnhancements.userId, session.user.id),
                ),
            )
            .returning({ id: aiEnhancements.id });

        if (deleted.length > 0) {
            await tx
                .update(recordings)
                .set({ updatedAt: new Date() })
                .where(
                    and(
                        eq(recordings.id, id),
                        eq(recordings.userId, session.user.id),
                        isNull(recordings.deletedAt),
                    ),
                );
        }
    });

    return NextResponse.json({ success: true });
});
