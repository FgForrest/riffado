import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { generateServerWaveform } from "@/lib/audio/server-waveform";
import { DEFAULT_BUCKETS } from "@/lib/audio/waveform";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { requireRecordingAccess } from "@/lib/sharing/access";
import { createUserStorageProvider } from "@/lib/storage/factory";

type IdContext = { params: Promise<{ id: string }> };

const MAX_PEAKS = 2048;
const MIN_PEAKS = 32;

export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    // Client-computed peaks are only taken from the owner; anyone else who
    // can see the recording asks for server-computed ones (PUT).
    const { ownerUserId, role } = await requireRecordingAccess(
        session.user.id,
        id,
    );
    if (role !== "owner") {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid JSON body", 400);
    }

    const peaks =
        body && typeof body === "object" && "peaks" in body
            ? (body as { peaks: unknown }).peaks
            : null;

    if (!Array.isArray(peaks)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Expected { peaks: number[] }",
            400,
        );
    }

    if (peaks.length < MIN_PEAKS || peaks.length > MAX_PEAKS) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `peaks must contain between ${MIN_PEAKS} and ${MAX_PEAKS} values`,
            400,
        );
    }

    const normalized: number[] = [];
    for (const v of peaks) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "peaks must be finite numbers in [0, 1]",
                400,
            );
        }
        normalized.push(Math.round(v * 1000) / 1000);
    }

    const [recording] = await db
        .select({ id: recordings.id, waveformPeaks: recordings.waveformPeaks })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, ownerUserId),
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

    if (recording.waveformPeaks) {
        return NextResponse.json({ stored: false });
    }

    // Conditional write: predicates on UPDATE so a concurrent DELETE
    // doesn't race; matches zero rows on tombstoned recordings. The
    // `waveformPeaks is null` clause makes the write idempotent under
    // racing POSTs -- first writer wins, the rest no-op.
    const result = await db
        .update(recordings)
        .set({ waveformPeaks: normalized, updatedAt: new Date() })
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, ownerUserId),
                isNull(recordings.deletedAt),
                isNull(recordings.waveformPeaks),
            ),
        );

    void result;

    return NextResponse.json({ stored: true });
});

export const PUT = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const { ownerUserId } = await requireRecordingAccess(session.user.id, id);

    const [recording] = await db
        .select({
            id: recordings.id,
            storagePath: recordings.storagePath,
            waveformPeaks: recordings.waveformPeaks,
            audioReapedAt: recordings.audioReapedAt,
        })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, ownerUserId),
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
    if (recording.waveformPeaks) {
        return NextResponse.json({ peaks: recording.waveformPeaks });
    }
    if (recording.audioReapedAt) {
        throw new AppError(
            ErrorCode.RECORDING_DATA_REAPED,
            "Audio was removed by your retention policy",
            410,
        );
    }

    const storage = await createUserStorageProvider(ownerUserId);
    const audio = await storage.downloadFile(recording.storagePath);
    const peaks = await generateServerWaveform(audio, DEFAULT_BUCKETS);

    await db
        .update(recordings)
        .set({ waveformPeaks: peaks, updatedAt: new Date() })
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, ownerUserId),
                isNull(recordings.deletedAt),
                isNull(recordings.waveformPeaks),
            ),
        );

    return NextResponse.json({ peaks });
});
