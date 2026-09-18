import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { Workstation } from "@/components/dashboard/workstation";
import { db } from "@/db";
import {
    aiEnhancements,
    plaudConnections,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { requireAuth } from "@/lib/auth-server";
import { decryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { listFolderOrganization } from "@/lib/folders/folders";
import { organizationForDeployment } from "@/lib/folders/hierarchy";
import { isAdminEmail } from "@/lib/hosted/admin/guard";
import { initialSettingsFromRow } from "@/lib/settings/initial-settings";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import { serializeRecording } from "@/types/recording";

export default async function DashboardPage() {
    const session = await requireAuth();

    const [
        userRecordings,
        userTranscriptions,
        userSummaryRows,
        [settingsRow],
        [connectionRow],
        folderOrganization,
    ] = await Promise.all([
        db
            .select({
                id: recordings.id,
                filename: recordings.filename,
                duration: recordings.duration,
                startTime: recordings.startTime,
                filesize: recordings.filesize,
                deviceSn: recordings.deviceSn,
                waveformPeaks: recordings.waveformPeaks,
                // So the player can say "audio was removed by your
                // retention policy" instead of rendering a dead <audio>
                // element that fails on first play.
                audioReapedAt: recordings.audioReapedAt,
            })
            .from(recordings)
            .where(
                and(
                    eq(recordings.userId, session.user.id),
                    isNull(recordings.deletedAt),
                ),
            )
            .orderBy(desc(recordings.startTime)),
        db
            .select({
                recordingId: transcriptions.recordingId,
                text: transcriptions.text,
                language: transcriptions.detectedLanguage,
                // Provenance, not decoration: the transcript view needs it to
                // decide whether this text was diarized and can be rendered
                // as a dialog.
                source: transcriptions.source,
                provider: transcriptions.provider,
                model: transcriptions.model,
                // Provider-reported turns, preferred over re-deriving them
                // from the text because only these carry timings.
                turns: transcriptions.turns,
            })
            .from(transcriptions)
            .where(eq(transcriptions.userId, session.user.id)),
        // We only need to know IF a summary exists per recording for the
        // list status chip — the full summary is still fetched on
        // selection by the existing /api/recordings/[id]/summary route.
        db
            .select({ recordingId: aiEnhancements.recordingId })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.userId, session.user.id),
                    isNotNull(aiEnhancements.summary),
                ),
            ),
        // Load user settings server-side so the Workstation, list, and
        // player render with the user's preferences on first paint — no
        // waterfall of /api/settings/user fetches from three different
        // components.
        db
            .select()
            .from(userSettings)
            .where(eq(userSettings.userId, session.user.id))
            .limit(1),
        db
            .select({ invalidatedAt: plaudConnections.invalidatedAt })
            .from(plaudConnections)
            .where(eq(plaudConnections.userId, session.user.id))
            .limit(1),
        listFolderOrganization(session.user.id),
    ]);
    const summaryIds = new Set(userSummaryRows.map((r) => r.recordingId));
    const transcriptIds = new Set(userTranscriptions.map((t) => t.recordingId));

    // Content fields are encrypted at rest; decrypt server-side (this is
    // an RSC — client never sees a key) before serializing for the
    // workstation. Legacy plaintext rows pass through verbatim.
    const recordingsData = userRecordings.map(
        ({ waveformPeaks, audioReapedAt, ...r }) =>
            serializeRecording(
                { ...r, filename: decryptText(r.filename) },
                {
                    hasTranscript: transcriptIds.has(r.id),
                    hasSummary: summaryIds.has(r.id),
                    audioReaped: audioReapedAt !== null,
                    // jsonb comes back already-parsed; coerce to the typed shape.
                    waveformPeaks: Array.isArray(waveformPeaks)
                        ? (waveformPeaks as number[])
                        : null,
                },
            ),
    );

    const preferredTranscriptSource =
        settingsRow?.preferredTranscriptSource ?? "plaud";
    const transcriptVariants = new Map<
        string,
        Array<{
            source: string;
            text: string;
            language?: string;
            provider?: string;
            model?: string;
            turns: ReturnType<typeof readTranscriptTurns>;
        }>
    >();
    for (const transcript of userTranscriptions) {
        const variant = {
            source: transcript.source,
            text: decryptText(transcript.text),
            language: transcript.language || undefined,
            provider: transcript.provider ?? undefined,
            model: transcript.model ?? undefined,
            turns: readTranscriptTurns(transcript),
        };
        const variants = transcriptVariants.get(transcript.recordingId) ?? [];
        variants.push(variant);
        transcriptVariants.set(transcript.recordingId, variants);
    }
    for (const variants of transcriptVariants.values()) {
        variants.sort((left, right) => {
            if (left.source === preferredTranscriptSource) return -1;
            if (right.source === preferredTranscriptSource) return 1;
            return left.source.localeCompare(right.source);
        });
    }
    const transcriptionMap = new Map(
        Array.from(transcriptVariants, ([recordingId, variants]) => [
            recordingId,
            variants[0],
        ]),
    );

    // One source of truth for InitialSettings + their defaults lives in
    // `src/lib/settings/initial-settings.ts`; adding a new preference
    // there is the only place callers need to touch.
    const initialSettings = initialSettingsFromRow(settingsRow);
    const visibleFolderOrganization = organizationForDeployment(
        folderOrganization,
        {
            isHosted: env.IS_HOSTED,
            selfHostMode: env.SELF_HOST_MODE,
        },
    );

    return (
        <Workstation
            recordings={recordingsData}
            transcriptions={transcriptionMap}
            transcriptVariants={transcriptVariants}
            isAdmin={isAdminEmail(session.user.email)}
            userEmail={session.user.email ?? null}
            initialSettings={initialSettings}
            plaudNeedsReconnect={connectionRow?.invalidatedAt != null}
            isHosted={env.IS_HOSTED}
            filesystemExportsAvailable={
                !env.IS_HOSTED && Boolean(env.FILESYSTEM_EXPORT_ROOT)
            }
            initialFolderOrganization={visibleFolderOrganization}
        />
    );
}
