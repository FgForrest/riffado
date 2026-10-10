import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { Workstation } from "@/components/dashboard/workstation";
import { db } from "@/db";
import { recordingItemJoin } from "@/db/items";
import {
    aiEnhancements,
    chatterItems,
    plaudConnections,
    recordings,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { requireAuth } from "@/lib/auth-server";
import { decryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { exportProvidersAvailability } from "@/lib/folder-exports/configurations";
import { listFolderOrganization } from "@/lib/folders/folders";
import { organizationForDeployment } from "@/lib/folders/hierarchy";
import { isAdminEmail } from "@/lib/hosted/admin/guard";
import { confirmedOverlays } from "@/lib/learn/llm-input";
import { recordingsNeedingReview } from "@/lib/learn/pending";
import { type OverlayCorrection, readTextOf } from "@/lib/learn/render";
import { isMailEnabled } from "@/lib/mail/config";
import { loadMailListRows, loadSharedMailRows } from "@/lib/mail/list";
import { getOrgUserId, isOrgAccount } from "@/lib/org/config";
import { initialSettingsFromRow } from "@/lib/settings/initial-settings";
import { sharedRecordingCondition } from "@/lib/sharing/access";
import { readTranscriptTopics } from "@/lib/topics/stored-topics";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import { serializeRecording } from "@/types/recording";

type TranscriptRow = {
    id: string;
    revision: number;
    recordingId: string;
    text: string;
    detectedLanguage: string | null;
    source: string;
    provider: string | null;
    model: string | null;
    turns: unknown;
    topics: unknown;
};

type TranscriptVariant = {
    source: string;
    text: string;
    version: { transcriptionId: string; revision: number };
    language?: string;
    provider?: string;
    model?: string;
    turns: ReturnType<typeof readTranscriptTurns>;
    topics: ReturnType<typeof readTranscriptTopics>;
    /**
     * The text as people read it, its corrections applied, when any
     * change it: what the list previews and searches beside the text.
     */
    readText?: string;
};

/** Decrypt transcript rows into per-recording variants, preferred source first. */
function buildTranscriptVariants(
    rows: TranscriptRow[],
    preferredSource: string,
    /** Each transcript's confirmed corrections (`confirmedOverlays`). */
    overlays: ReadonlyMap<string, OverlayCorrection[]> = new Map(),
): Map<string, TranscriptVariant[]> {
    const variantsByRecording = new Map<string, TranscriptVariant[]>();
    for (const transcript of rows) {
        const turns = readTranscriptTurns(transcript);
        const readText = readTextOf(turns, overlays.get(transcript.id));
        const variant = {
            source: transcript.source,
            text: decryptText(transcript.text),
            version: {
                transcriptionId: transcript.id,
                revision: transcript.revision,
            },
            language: transcript.detectedLanguage || undefined,
            provider: transcript.provider ?? undefined,
            model: transcript.model ?? undefined,
            turns,
            topics: readTranscriptTopics(transcript),
            ...(readText !== null ? { readText } : {}),
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
 * The Organization library: every shared recording, with its owner's rows,
 * as a shared recording is one recording.
 */
async function loadOrganizationLibrary(
    viewerId: string,
    orgUserId: string,
    preferredSource: string,
    /** Recordings whose review waits for the viewer (the organization account's). */
    reviewIds: ReadonlySet<string> = new Set(),
) {
    const rows = await db
        .select({
            id: recordings.id,
            userId: recordings.userId,
            filename: chatterItems.title,
            duration: recordings.duration,
            startTime: chatterItems.occurredAt,
            filesize: recordings.filesize,
            deviceSn: recordings.deviceSn,
            waveformPeaks: recordings.waveformPeaks,
            audioReapedAt: recordings.audioReapedAt,
            ownerName: users.name,
            ownerEmail: users.email,
        })
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .innerJoin(users, eq(users.id, recordings.userId))
        .where(
            and(
                isNull(recordings.deletedAt),
                sharedRecordingCondition(orgUserId),
            ),
        )
        .orderBy(desc(chatterItems.occurredAt));
    const [transcriptRows, summaryRows] = await Promise.all([
        db
            .select({ transcription: transcriptions })
            .from(transcriptions)
            .innerJoin(
                recordings,
                and(
                    eq(recordings.id, transcriptions.recordingId),
                    eq(recordings.userId, transcriptions.userId),
                ),
            )
            .where(
                and(
                    isNull(recordings.deletedAt),
                    sharedRecordingCondition(orgUserId),
                ),
            )
            .then((found) => found.map((row) => row.transcription)),
        db
            .select({ recordingId: aiEnhancements.itemId })
            .from(aiEnhancements)
            .innerJoin(
                recordings,
                and(
                    eq(recordings.id, aiEnhancements.itemId),
                    eq(recordings.userId, aiEnhancements.userId),
                ),
            )
            .where(
                and(
                    isNotNull(aiEnhancements.summary),
                    isNull(recordings.deletedAt),
                    sharedRecordingCondition(orgUserId),
                ),
            ),
    ]);
    const summaryIds = new Set(summaryRows.map((row) => row.recordingId));
    const transcriptIds = new Set(transcriptRows.map((row) => row.recordingId));
    const variants = buildTranscriptVariants(
        transcriptRows,
        preferredSource,
        transcriptRows.length > 0
            ? await confirmedOverlays({ organization: true })
            : new Map(),
    );
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
                    needsReview: reviewIds.has(row.id),
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
    const sharedMail = await loadSharedMailRows(viewerId, orgUserId);
    return {
        recordings:
            sharedMail.length > 0
                ? [...library, ...sharedMail].sort(
                      (left, right) =>
                          Date.parse(right.startTime) -
                          Date.parse(left.startTime),
                  )
                : library,
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
                filename: chatterItems.title,
                duration: recordings.duration,
                startTime: chatterItems.occurredAt,
                filesize: recordings.filesize,
                deviceSn: recordings.deviceSn,
                waveformPeaks: recordings.waveformPeaks,
                // So the player can say "audio was removed by your
                // retention policy" instead of rendering a dead <audio>
                // element that fails on first play.
                audioReapedAt: recordings.audioReapedAt,
            })
            .from(recordings)
            .innerJoin(chatterItems, recordingItemJoin)
            .where(
                and(
                    eq(recordings.userId, session.user.id),
                    isNull(recordings.deletedAt),
                ),
            )
            .orderBy(desc(chatterItems.occurredAt)),
        db
            .select({
                // Which stored transcript each text is: speaker changes
                // name it.
                id: transcriptions.id,
                revision: transcriptions.revision,
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
                topics: transcriptions.topics,
            })
            .from(transcriptions)
            .where(eq(transcriptions.userId, session.user.id)),
        // We only need to know IF a summary exists per recording for the
        // list status chip — the full summary is still fetched on
        // selection by the existing /api/recordings/[id]/summary route.
        db
            .select({ recordingId: aiEnhancements.itemId })
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
    const reviewIds = await recordingsNeedingReview(
        session.user.id,
        viewerIsOrgAccount,
    );

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
                    needsReview: reviewIds.has(r.id),
                    audioReaped: audioReapedAt !== null,
                    // jsonb comes back already-parsed; coerce to the typed shape.
                    waveformPeaks: Array.isArray(waveformPeaks)
                        ? (waveformPeaks as number[])
                        : null,
                },
            ),
    );

    // Mail sits in the same pile; the organization account has none.
    const mailRows = viewerIsOrgAccount
        ? []
        : await loadMailListRows(session.user.id);

    const preferredTranscriptSource =
        settingsRow?.preferredTranscriptSource ?? "plaud";
    const transcriptVariants = buildTranscriptVariants(
        ownTranscriptions,
        preferredTranscriptSource,
        ownTranscriptions.length > 0
            ? await confirmedOverlays({ ownerUserId: session.user.id })
            : new Map(),
    );
    const transcriptionMap = primaryVariants(transcriptVariants);

    const organizationLibrary = orgUserId
        ? await loadOrganizationLibrary(
              session.user.id,
              orgUserId,
              preferredTranscriptSource,
              viewerIsOrgAccount ? reviewIds : new Set(),
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
            recordings={[...recordingsData, ...mailRows]}
            transcriptions={transcriptionMap}
            transcriptVariants={transcriptVariants}
            organizationLibrary={organizationLibrary}
            isOrgAccount={viewerIsOrgAccount}
            isAdmin={isAdminEmail(session.user.email)}
            userEmail={session.user.email ?? null}
            initialSettings={initialSettings}
            plaudNeedsReconnect={connectionRow?.invalidatedAt != null}
            isHosted={env.IS_HOSTED}
            mailEnabled={isMailEnabled() && !viewerIsOrgAccount}
            exportProviders={exportProvidersAvailability()}
            initialFolderOrganization={visibleFolderOrganization}
        />
    );
}
