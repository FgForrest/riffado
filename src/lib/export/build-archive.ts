import { PassThrough, type Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import type { StorageProvider } from "@/lib/storage/types";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import { resolvePrimaryTranscript } from "@/lib/v1/serialize";

export interface ArchiveResult {
    recordingCount: number;
    fileSize: number;
}

interface ManifestRecording {
    id: string;
    filename: string;
    startTime: string;
    endTime: string;
    duration: number;
    filesize: number;
    deviceSn: string;
    audio: { included: boolean; path: string | null; reason?: string };
    transcript: { included: boolean; path: string | null };
    transcripts: {
        included: boolean;
        path: string | null;
        count: number;
    };
    summary: { included: boolean; path: string | null };
    summaries: { included: boolean; path: string | null; count: number };
}

// Which transcript `transcript.txt` renders when a recording has more than
// one. `resolvePrimaryTranscript` falls back to "riffado" and then to the
// first row, so this only decides the head of that order.
const ARCHIVE_PRIMARY_SOURCE = "plaud";

function audioExtension(storagePath: string): string {
    const match = storagePath.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : "mp3";
}

/** Filesystem-safe, stable folder name per recording inside the archive. */
function folderName(recording: { id: string; startTime: Date }): string {
    const iso = recording.startTime.toISOString().replace(/[:.]/g, "-");
    return `${iso}_${recording.id}`;
}

/**
 * Streams a full-data archive for `userId` into `destinationStorage` at
 * `storageKey`. Audio is streamed recording-by-recording straight out of
 * `sourceStorage` into the zip and back out to the destination -- at no
 * point is the whole archive, or more than one recording's audio, held
 * in memory.
 *
 * Source and destination are separate providers because they need not be
 * the same place: `BACKUP_STORAGE_PATH` puts archives on a different
 * disk from the recordings, which is the point of having a backup. They
 * are the same object when it is unset.
 *
 * A recording whose audio can't be read (deleted from storage, transient
 * error) doesn't fail the whole export: it's noted in the manifest and
 * skipped, so the user still gets everything else.
 */
export async function buildAndUploadExportArchive(input: {
    userId: string;
    /** Where the recordings' audio is read from. */
    sourceStorage: StorageProvider;
    /** Where the finished archive is written. */
    destinationStorage: StorageProvider;
    storageKey: string;
    /** Aborting destroys the in-flight zip/upload streams immediately, instead of letting them run to completion in the background after the caller has given up (e.g. on the worker's stall timeout). */
    signal?: AbortSignal;
    /**
     * Called on every unit of forward progress (a chunk of archive bytes
     * written, or a recording's metadata-only entries finished). Lets
     * the caller implement a stall timeout -- "no progress for N
     * minutes" -- instead of a fixed total-duration timeout that would
     * unfairly kill large-but-healthy exports.
     */
    onProgress?: () => void;
}): Promise<ArchiveResult> {
    const {
        userId,
        sourceStorage,
        destinationStorage,
        storageKey,
        signal,
        onProgress,
    } = input;

    if (signal?.aborted) {
        throw new Error("Export aborted before starting");
    }

    const userRecordings = await db
        .select()
        .from(recordings)
        .where(
            and(eq(recordings.userId, userId), isNull(recordings.deletedAt)),
        );

    const recordingIds = userRecordings.map((r) => r.id);

    const userTranscriptions =
        recordingIds.length > 0
            ? await db
                  .select()
                  .from(transcriptions)
                  .where(eq(transcriptions.userId, userId))
            : [];
    // Grouped, not keyed: `transcriptions_recording_user_source_unique` lets a
    // Plaud import and the user's own provider coexist for one recording, and
    // a map keyed on the recording keeps whichever row the query returned last
    // -- silently dropping the other from the backup.
    const transcriptionMap = new Map<string, typeof userTranscriptions>();
    for (const transcript of userTranscriptions) {
        const group = transcriptionMap.get(transcript.recordingId) ?? [];
        group.push(transcript);
        transcriptionMap.set(transcript.recordingId, group);
    }

    const userEnhancements =
        recordingIds.length > 0
            ? await db
                  .select()
                  .from(aiEnhancements)
                  .where(eq(aiEnhancements.userId, userId))
            : [];
    // `summary` is a `text` column (encryptText); `actionItems`/`keyPoints`
    // are `jsonb` envelopes (encryptJsonField) -- same at-rest scheme the
    // summary API decrypts before returning to the client.
    const enhancementMap = new Map<
        string,
        Array<
            (typeof userEnhancements)[number] & {
                summary: string;
                actionItems: string[];
                keyPoints: string[];
            }
        >
    >();
    for (const enhancement of userEnhancements) {
        const group = enhancementMap.get(enhancement.recordingId) ?? [];
        group.push({
            ...enhancement,
            summary: decryptText(enhancement.summary) ?? "",
            actionItems:
                decryptJsonField<string[]>(enhancement.actionItems) ?? [],
            keyPoints: decryptJsonField<string[]>(enhancement.keyPoints) ?? [],
        });
        enhancementMap.set(enhancement.recordingId, group);
    }

    const archive = new ZipArchive({ zlib: { level: 6 } });
    const passthrough = new PassThrough();
    // Count bytes as they flow through rather than re-reading the
    // finished archive back out of storage just to learn its size.
    let fileSize = 0;
    passthrough.on("data", (chunk: Buffer) => {
        fileSize += chunk.length;
        onProgress?.();
    });
    archive.pipe(passthrough);

    // Surface archiver-level errors (e.g. a mid-stream audio read failure)
    // on the passthrough so the upload promise below rejects instead of
    // hanging forever waiting for a stream that will never finish.
    archive.on("error", (err: Error) => passthrough.destroy(err));
    archive.on("warning", (err: Error) => {
        console.warn(`[export] archiver warning for user ${userId}:`, err);
    });

    // Audio streams currently in flight, so an abort can actively tear
    // them down instead of leaving them half-open. Without this, a
    // proxy stream that archiver has stopped draining (post-abort)
    // would never emit `end`/`close`/`error` on its own, and the
    // per-entry `settled` promise it backs would never resolve --
    // exactly the hang this `onAbort` handler exists to prevent.
    const activeAudioStreams: { rawStream: Readable; proxy: PassThrough }[] =
        [];

    const onAbort = () => {
        archive.abort();
        passthrough.destroy(new Error("Export aborted"));
        for (const { rawStream, proxy } of activeAudioStreams) {
            rawStream.destroy(new Error("Export aborted"));
            proxy.destroy(new Error("Export aborted"));
        }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const uploadPromise = destinationStorage.uploadStream(
        storageKey,
        passthrough,
        "application/zip",
    );
    // `uploadPromise` is only *awaited* much later (after the
    // audio-settled wait and `archive.finalize()`), but it starts
    // rejecting the moment `passthrough` errors -- including from
    // `onAbort` firing while this function is still stuck earlier (e.g.
    // the audio-settled race below). Without this passive catch, that
    // earlier path throws first and the function returns without ever
    // reaching the real `await uploadPromise` below, leaving this
    // rejection unhandled. The actual error is still surfaced through
    // whichever path threw first; this only prevents an unobserved
    // rejection from the one that lost the race.
    uploadPromise.catch(() => {});

    const manifest: {
        version: string;
        createdAt: string;
        userId: string;
        recordings: ManifestRecording[];
        knowledge?: { people: number; attributions: number };
        organization?: { folders: number; assignments: number };
    } = {
        version: "2.0",
        createdAt: new Date().toISOString(),
        userId,
        recordings: [],
    };

    // Resolves once each recording's audio entry has fully settled
    // (archiver finished draining it, or it errored and was ended
    // gracefully) -- awaited below, before the manifest is serialized,
    // so `entry.audio` reflects what actually landed in the archive
    // rather than an optimistic guess made before the stream ran.
    const audioSettled: Promise<void>[] = [];

    for (const recording of userRecordings) {
        // Per-recording DB/metadata work has no byte-stream progress of
        // its own to trigger the passthrough listener above -- mark
        // forward progress explicitly so a library with many small
        // (or audio-less) recordings doesn't false-positive a stall
        // while it's genuinely working through the list.
        onProgress?.();
        const folder = folderName(recording);
        const entry: ManifestRecording = {
            id: recording.id,
            filename: decryptText(recording.filename),
            startTime: recording.startTime.toISOString(),
            endTime: recording.endTime.toISOString(),
            duration: recording.duration,
            filesize: recording.filesize,
            deviceSn: recording.deviceSn,
            audio: { included: false, path: null },
            transcript: { included: false, path: null },
            transcripts: { included: false, path: null, count: 0 },
            summary: { included: false, path: null },
            summaries: { included: false, path: null, count: 0 },
        };

        const audioExists = await sourceStorage
            .exists(recording.storagePath)
            .catch(() => false);
        if (audioExists) {
            try {
                const rawStream = await sourceStorage.downloadStream(
                    recording.storagePath,
                );
                const audioPath = `${folder}/audio.${audioExtension(recording.storagePath)}`;

                // Proxy the raw storage stream through our own PassThrough
                // instead of appending it to the archive directly. A
                // mid-stream error on the raw stream (network drop,
                // storage hiccup) would otherwise surface as an archiver
                // `error` event and abort the *entire* archive -- the
                // try/catch above only covers stream *creation*, not
                // errors emitted while archiver is draining it. Ending
                // the proxy gracefully on such an error instead leaves
                // this one entry truncated (or empty) while every other
                // recording still makes it into the archive.
                const proxy = new PassThrough();
                const settled = new Promise<void>((resolve) => {
                    let done = false;
                    const finish = () => {
                        if (done) return;
                        done = true;
                        resolve();
                    };
                    rawStream.once("error", (err) => {
                        entry.audio = {
                            included: false,
                            path: null,
                            reason: `Audio stream interrupted: ${err instanceof Error ? err.message : String(err)}`,
                        };
                        // Gracefully end the proxy instead of letting the
                        // error propagate into archiver -- archiver treats
                        // a source-stream error as fatal to the whole
                        // archive. Ending early just truncates this one
                        // entry.
                        proxy.end();
                        finish();
                    });
                    proxy.once("error", finish);
                    proxy.once("close", finish);
                    proxy.once("end", finish);
                });
                audioSettled.push(settled);
                activeAudioStreams.push({ rawStream, proxy });
                rawStream.pipe(proxy);

                // Audio is already compressed (mp3/opus/etc.) -- deflating
                // it again wastes CPU for near-zero size benefit. `store:
                // true` writes it uncompressed into the zip.
                archive.append(proxy, { name: audioPath, store: true });
                entry.audio = { included: true, path: audioPath };
            } catch (error) {
                entry.audio = {
                    included: false,
                    path: null,
                    reason:
                        error instanceof Error ? error.message : String(error),
                };
            }
        } else {
            entry.audio = {
                included: false,
                path: null,
                reason: "Audio file not found in storage",
            };
        }

        const recordingTranscripts = transcriptionMap.get(recording.id) ?? [];
        // `transcript.txt` is the readable one and holds a single transcript,
        // so which one is a choice. It is made without consulting the user's
        // display preference on purpose: a backup whose bytes change because
        // somebody flipped a setting is a worse backup, and nothing is lost
        // either way -- `transcripts.json` beside it carries all of them.
        const primary = resolvePrimaryTranscript(
            recordingTranscripts,
            ARCHIVE_PRIMARY_SOURCE,
        );
        if (primary) {
            const transcriptPath = `${folder}/transcript.txt`;
            archive.append(Buffer.from(decryptText(primary.text), "utf-8"), {
                name: transcriptPath,
            });
            entry.transcript = { included: true, path: transcriptPath };
        }

        // The restorable record. `knowledge/people.json` keys every
        // attribution on a transcription id, so without the ids written down
        // beside the text the knowledge base names rows a restore cannot
        // find, and the turns it would be projected onto are gone too.
        if (recordingTranscripts.length > 0) {
            const transcriptsPath = `${folder}/transcripts.json`;
            archive.append(
                Buffer.from(
                    JSON.stringify(
                        recordingTranscripts.map((transcript) => ({
                            id: transcript.id,
                            recordingId: transcript.recordingId,
                            source: transcript.source,
                            provider: transcript.provider,
                            model: transcript.model,
                            detectedLanguage: transcript.detectedLanguage,
                            text: decryptText(transcript.text),
                            turns: readTranscriptTurns(transcript),
                            createdAt: transcript.createdAt.toISOString(),
                        })),
                        null,
                        2,
                    ),
                ),
                { name: transcriptsPath },
            );
            entry.transcripts = {
                included: true,
                path: transcriptsPath,
                count: recordingTranscripts.length,
            };
        }

        const recordingEnhancements = enhancementMap.get(recording.id) ?? [];
        const enhancement =
            recordingEnhancements.find((item) => item.source === "plaud") ??
            recordingEnhancements.find((item) => item.source === "riffado") ??
            recordingEnhancements[0];
        if (enhancement) {
            const summaryPath = `${folder}/summary.json`;
            archive.append(
                Buffer.from(
                    JSON.stringify(
                        {
                            summary: enhancement.summary,
                            actionItems: enhancement.actionItems,
                            keyPoints: enhancement.keyPoints,
                            source: enhancement.source,
                            transcriptionId: enhancement.transcriptionId,
                            provider: enhancement.provider,
                            model: enhancement.model,
                            createdAt: enhancement.createdAt.toISOString(),
                        },
                        null,
                        2,
                    ),
                ),
                { name: summaryPath },
            );
            entry.summary = { included: true, path: summaryPath };
        }
        if (recordingEnhancements.length > 0) {
            const summariesPath = `${folder}/summaries.json`;
            archive.append(
                Buffer.from(
                    JSON.stringify(
                        recordingEnhancements.map((item) => ({
                            id: item.id,
                            recordingId: item.recordingId,
                            transcriptionId: item.transcriptionId,
                            source: item.source,
                            summary: item.summary,
                            actionItems: item.actionItems,
                            keyPoints: item.keyPoints,
                            provider: item.provider,
                            model: item.model,
                            createdAt: item.createdAt.toISOString(),
                        })),
                        null,
                        2,
                    ),
                ),
                { name: summariesPath },
            );
            entry.summaries = {
                included: true,
                path: summariesPath,
                count: recordingEnhancements.length,
            };
        }

        manifest.recordings.push(entry);
    }

    // Wait for every audio entry to actually settle (archiver finished
    // draining it, or it errored and was gracefully truncated) before
    // serializing the manifest, so `entry.audio` reflects reality
    // instead of the optimistic guess made when the stream was appended.
    //
    // Raced against `signal` rather than awaited bare: if an abort
    // fires while this is pending, `onAbort` destroys the in-flight
    // audio streams above, but there's still a window where archiver
    // itself has simply stopped draining a stream without formally
    // ending it. Without this race, that would hang here forever
    // instead of rejecting -- defeating the whole point of the worker's
    // stall/max-duration guard, which needs this promise to actually
    // settle to stop the job.
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onAbortWhileWaiting = () => {
            if (settled) return;
            settled = true;
            reject(
                new Error(
                    "Export aborted while waiting for audio entries to settle",
                ),
            );
        };
        if (signal?.aborted) {
            onAbortWhileWaiting();
            return;
        }
        signal?.addEventListener("abort", onAbortWhileWaiting, { once: true });
        Promise.all(audioSettled).then(
            () => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener("abort", onAbortWhileWaiting);
                resolve();
            },
            (err) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener("abort", onAbortWhileWaiting);
                reject(err);
            },
        );
    });

    // The knowledge base rides along as data, decrypted like everything else
    // in the archive. Export parity is the proof a user can leave, so a
    // backup that restores recordings but loses who was speaking in them is
    // not a backup of this feature at all.
    const knowledge = await collectKnowledgeBase(userId);
    if (knowledge.people.length > 0 || knowledge.attributions.length > 0) {
        archive.append(Buffer.from(JSON.stringify(knowledge, null, 2)), {
            name: "knowledge/people.json",
        });
        manifest.knowledge = {
            people: knowledge.people.length,
            attributions: knowledge.attributions.length,
        };
    }

    const organization = await collectFolderOrganization(
        userId,
        new Set(recordingIds),
    );
    if (organization.folders.length > 0) {
        archive.append(Buffer.from(JSON.stringify(organization, null, 2)), {
            name: "organization/folders.json",
        });
        manifest.organization = {
            folders: organization.folders.length,
            assignments: organization.assignments.length,
        };
    }

    archive.append(Buffer.from(JSON.stringify(manifest, null, 2)), {
        name: "manifest.json",
    });

    try {
        await archive.finalize();
        await uploadPromise;
    } finally {
        signal?.removeEventListener("abort", onAbort);
    }

    return { recordingCount: userRecordings.length, fileSize };
}

interface ArchivedFolderOrganization {
    folders: {
        id: string;
        parentId: string | null;
        name: string;
        kind: string;
        sortOrder: number;
        createdAt: string;
    }[];
    assignments: { recordingId: string; folderId: string }[];
}

async function collectFolderOrganization(
    userId: string,
    activeRecordingIds: Set<string>,
): Promise<ArchivedFolderOrganization> {
    const [folderRows, assignmentRows] = await Promise.all([
        db
            .select({
                id: recordingFolders.id,
                parentId: recordingFolders.parentId,
                name: recordingFolders.name,
                kind: recordingFolders.kind,
                sortOrder: recordingFolders.sortOrder,
                createdAt: recordingFolders.createdAt,
            })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, userId)),
        db
            .select({
                recordingId: recordingFolderAssignments.recordingId,
                folderId: recordingFolderAssignments.folderId,
            })
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.userId, userId)),
    ]);

    return {
        folders: folderRows.map((row) => ({
            id: row.id,
            parentId: row.parentId,
            name: decryptText(row.name),
            kind: row.kind,
            sortOrder: row.sortOrder,
            createdAt: row.createdAt.toISOString(),
        })),
        assignments: assignmentRows.filter((row) =>
            activeRecordingIds.has(row.recordingId),
        ),
    };
}

interface ArchivedKnowledgeBase {
    people: {
        id: string;
        displayName: string;
        primaryEmail: string | null;
        notes: string | null;
        mergedIntoId: string | null;
        createdAt: string;
    }[];
    attributions: {
        transcriptionId: string;
        label: string;
        personId: string | null;
        source: string;
        status: string;
        confidence: number | null;
        evidenceStartMs: number | null;
    }[];
}

// The knowledge base for one user, decrypted for the archive.
//
// `primaryEmailHash` is deliberately not exported: it is derived from the
// email with a server secret and a restore can recompute it, while carrying
// it would pin the archive to one instance's secret.
async function collectKnowledgeBase(
    userId: string,
): Promise<ArchivedKnowledgeBase> {
    const [peopleRows, attributionRows] = await Promise.all([
        db
            .select({
                id: people.id,
                displayName: people.displayName,
                primaryEmail: people.primaryEmail,
                notes: people.notes,
                mergedIntoId: people.mergedIntoId,
                createdAt: people.createdAt,
            })
            .from(people)
            .where(eq(people.userId, userId)),
        db
            .select({
                transcriptionId: transcriptSpeakers.transcriptionId,
                label: transcriptSpeakers.label,
                personId: transcriptSpeakers.personId,
                source: transcriptSpeakers.source,
                status: transcriptSpeakers.status,
                confidence: transcriptSpeakers.confidence,
                evidenceStartMs: transcriptSpeakers.evidenceStartMs,
            })
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.userId, userId)),
    ]);

    return {
        people: peopleRows.map((row) => ({
            id: row.id,
            displayName: decryptText(row.displayName),
            primaryEmail: row.primaryEmail
                ? decryptText(row.primaryEmail)
                : null,
            notes: row.notes ? decryptText(row.notes) : null,
            mergedIntoId: row.mergedIntoId,
            createdAt: row.createdAt.toISOString(),
        })),
        attributions: attributionRows,
    };
}
