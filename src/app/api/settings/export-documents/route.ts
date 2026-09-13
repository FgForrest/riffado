import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordings, userSettings } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    exportRecordingSidecars,
    type SidecarSelection,
} from "@/lib/export/document-sidecars";

/**
 * POST /api/settings/export-documents
 *
 * Backfill: write the sidecar documents the user has enabled for every
 * recording they already own. The automatic path only covers recordings
 * transcribed or summarized after the toggle was switched on.
 *
 * Runs inline and sequentially, so the response time scales with library
 * size. Recordings whose export fails are counted and reported rather
 * than aborting the run.
 */
export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const [settings] = await db
        .select({
            transcript: userSettings.autoExportTranscript,
            summary: userSettings.autoExportSummary,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, session.user.id))
        .limit(1);

    const selection: SidecarSelection = {
        transcript: settings?.transcript ?? false,
        summary: settings?.summary ?? false,
    };

    if (!selection.transcript && !selection.summary) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Enable transcript or summary export before running a backfill.",
            400,
        );
    }

    const rows = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.userId, session.user.id),
                isNull(recordings.deletedAt),
            ),
        );

    let transcripts = 0;
    let summaries = 0;
    let failed = 0;

    for (const row of rows) {
        try {
            const written = await exportRecordingSidecars(
                session.user.id,
                row.id,
                selection,
            );
            if (written.includes("transcript")) transcripts += 1;
            if (written.includes("summary")) summaries += 1;
        } catch (error) {
            failed += 1;
            console.error(
                `Document export failed for recording ${row.id}:`,
                error,
            );
        }
    }

    return NextResponse.json({
        recordings: rows.length,
        transcripts,
        summaries,
        failed,
    });
});
