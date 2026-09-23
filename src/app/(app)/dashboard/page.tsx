import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { Workstation } from "@/components/dashboard/workstation";
import { db } from "@/db";
import {
    aiEnhancements,
    plaudConnections,
    recordings,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { requireAuth } from "@/lib/auth-server";
import { decryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { listFolderOrganization } from "@/lib/folders/folders";
import { organizationForDeployment } from "@/lib/folders/hierarchy";
import { isAdminEmail } from "@/lib/hosted/admin/guard";
import { getOrgUserId, isOrgAccount } from "@/lib/org/config";
import { initialSettingsFromRow } from "@/lib/settings/initial-settings";
import { sharedRecordingCondition } from "@/lib/sharing/access";
import {
    readOrgViewSummaryRecordingIds,
    readOrgViewTranscriptRows,
} from "@/lib/sharing/view-content";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import { serializeRecording } from "@/types/recording";

type TranscriptRow = {
    recordingId: string;
    text: string;
    detectedLanguage: string | null;
    source: string;
    provider: string | null;
    model: string | null;
    turns: unknown;
};

type TranscriptVariant = {
    source: string;
    text: string;
    language?: string;
    provider?: string;
    model?: string;
    turns: ReturnType<typeof readTranscriptTurns>;
};

/** Decrypt transcript rows into per-recording variants, preferred source first. */
function buildTranscriptVariants(
    rows: TranscriptRow[],
    preferredSource: string,
): Map<string, TranscriptVariant[]> {
    const variantsByRecording = new Map<string, TranscriptVariant[]>();
    for (const transcript of rows) {
        const variant = {
            source: transcript.source,
            text: decryptText(transcript.text),
            language: transcript.detectedLanguage || undefined,
            provider: transcript.provider ?? undefined,
            model: transcript.model ?? undefined,
            turns: readTranscriptTurns(transcript),
        };
        const variants = variantsByRecording.get(transcript.recordingId) ?? [];
        variants.push(variant);
        variantsByRecording.set(transcript.recordingId, variants);
    }
    for (const variants of variantsByRecording.values()) {
        variants.sort((left, right) => {
            if (left.source === preferredSource) return -1;
            if (right.source === preferredSource) return 1;
            return left.source.localeCompare(right.source);
        });
    }
    return variantsByRecording;
}

function primaryVariants(
    variants: Map<string, TranscriptVariant[]>,
): Map<string, TranscriptVariant> {
    return new Map(
        Array.from(variants, ([recordingId, list]) => [recordingId, list[0]]),
    );
}

/**
 * The Organization library: every shared recording, read through its
 * Organization view (the organization's rows, else the owner's).
 */
async function loadOrganizationLibrary(
    viewerId: string,
    orgUserId: string,
    preferredSource: string,
) {
    const rows = await db
        .select({
            id: recordings.id,
            userId: recordings.userId,
            filename: recordings.filename,
            duration: recordings.duration,
            startTime: recordings.startTime,
            filesize: recordings.filesize,
            deviceSn: recordings.deviceSn,
            waveformPeaks: recordings.waveformPeaks,
            audioReapedAt: recordings.audioReapedAt,
            ownerName: users.name,
            ownerEmail: users.email,
        })
        .from(recordings)
        .innerJoin(users, eq(users.id, recordings.userId))
        .where(
            and(
                isNull(recordings.deletedAt),
                sharedRecordingCondition(orgUserId),
            ),
        )
        .orderBy(desc(recordings.startTime));
    const refs = rows.map((row) => ({ id: row.id, ownerUserId: row.userId }));
    const [{ rows: transcriptRows }, summaryIds] = await Promise.all([
        readOrgViewTranscriptRows(refs, orgUserId),
        readOrgViewSummaryRecordingIds(refs, orgUserId),
    ]);
    const transcriptIds = new Set(transcriptRows.map((row) => row.recordingId));
    const variants = buildTranscriptVariants(transcriptRows, preferredSource);
    const library = rows.map(
        ({
            waveformPeaks,
            audioReapedAt,
            userId,
            ownerName,
            ownerEmail,
            ...row
        }) =>
            serializeRecording(
                { ...row, filename: decryptText(row.filename) },
                {
                    hasTranscript: transcriptIds.has(row.id),
                    hasSummary: summaryIds.has(row.id),
                    audioReaped: audioReapedAt !== null,
                    waveformPeaks: Array.isArray(waveformPeaks)
                        ? (waveformPeaks as number[])
                        : null,
                    view: "org",
                    isOwn: userId === viewerId,
                    ownerName: ownerName || ownerEmail,
                },
            ),
    );
    return {
        recordings: library,
        transcriptVariants: variants,
        transcriptions: primaryVariants(variants),
    };
}

export default async function DashboardPage() {
    const session = await requireAuth();

    const [
        userRecordings,
        userTranscriptions,
        userSummaryRows,
        [settingsRow],
        [connectionRow],
        folderOrganization,
        orgUserId,
        viewerIsOrgAccount,
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
                detectedLanguage: transcriptions.detectedLanguage,
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
        getOrgUserId(),
        isOrgAccount(session.user.id),
    ]);
    // The organization account owns no recordings; anything it would read
    // as "its own" is the Organization view, loaded below.
    const ownRecordings = viewerIsOrgAccount ? [] : userRecordings;
    const ownTranscriptions = viewerIsOrgAccount ? [] : userTranscriptions;
    const summaryIds = new Set(userSummaryRows.map((r) => r.recordingId));
    const transcriptIds = new Set(ownTranscriptions.map((t) => t.recordingId));

    // Content fields are encrypted at rest; decrypt server-side (this is
    // an RSC — client never sees a key) before serializing for the
    // workstation. Legacy plaintext rows pass through verbatim.
    const recordingsData = ownRecordings.map(
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
    const transcriptVariants = buildTranscriptVariants(
        ownTranscriptions,
        preferredTranscriptSource,
    );
    const transcriptionMap = primaryVariants(transcriptVariants);

    const organizationLibrary = orgUserId
        ? await loadOrganizationLibrary(
              session.user.id,
              orgUserId,
              preferredTranscriptSource,
          )
        : null;

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
            organizationLibrary={organizationLibrary}
            isOrgAccount={viewerIsOrgAccount}
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
