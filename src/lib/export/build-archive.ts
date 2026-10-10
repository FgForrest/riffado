import { PassThrough, type Readable, Transform } from "node:stream";
import { ZipArchive } from "archiver";
import {
    and,
    eq,
    getTableColumns,
    inArray,
    isNotNull,
    isNull,
    or,
    type SQL,
    sql,
} from "drizzle-orm";
import { db } from "@/db";
import { audioItemColumns, recordingItemJoin } from "@/db/items";
import {
    aiEnhancements,
    aiUsageEvents,
    apiCredentials,
    chatterItems,
    knowledgeAliases,
    knowledgeEntities,
    knowledgeEntityNotes,
    knowledgeEntityTypes,
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeRelationTypes,
    knowledgeVocabularyProposals,
    knowledgeVocabularyProposalVotes,
    learnReviewItems,
    learnRuns,
    people,
    personNotes,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakerRejections,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import { decryptBuffer } from "@/lib/encryption";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import {
    type ArchiveScope,
    archivedRecordingCondition,
    scopeUserId,
} from "@/lib/export/archive-scope";
import { orgOwnedCondition } from "@/lib/knowledge/org-people";
import { collectArchivedMail } from "@/lib/mail/archive";
import type { StorageProvider } from "@/lib/storage/types";
import {
    archivedAssigneeIds,
    tasksForArchive,
    taskUpdatesForArchive,
} from "@/lib/tasks/archive";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import { resolvePrimaryTranscript } from "@/lib/v1/serialize";

export interface ArchiveResult {
    recordingCount: number;
    fileSize: number;
}

interface ManifestRecording {
    id: string;
    /** Whose recording it is: in the Organization's archive only. */
    owner?: { id: string; name: string | null; email: string };
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
    aiUsage?: { included: boolean; path: string | null; count: number };
    tasks?: { included: boolean; path: string | null; count: number };
    taskUpdates?: { included: boolean; path: string | null; count: number };
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
function folderName(recording: { id: string; occurredAt: Date }): string {
    const iso = recording.occurredAt.toISOString().replace(/[:.]/g, "-");
    return `${iso}_${recording.id}`;
}

/**
 * Streams a full-data archive of `scope` into `destinationStorage` at
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
    /** Whose content: one person's own, or the Organization's. */
    scope: ArchiveScope;
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
        scope,
        sourceStorage,
        destinationStorage,
        storageKey,
        signal,
        onProgress,
    } = input;

    if (signal?.aborted) {
        throw new Error("Export aborted before starting");
    }

    const userId = scopeUserId(scope);
    const userRecordings = await db
        .select({
            ...audioItemColumns,
            ownerName: users.name,
            ownerEmail: users.email,
        })
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .innerJoin(users, eq(users.id, recordings.userId))
        .where(archivedRecordingCondition(scope));

    const recordingIds = userRecordings.map((r) => r.id);

    // What a recording cost is its payer's: never in the Organization's.
    const userUsage =
        recordingIds.length > 0 && scope.kind === "personal"
            ? await db
                  .select()
                  .from(aiUsageEvents)
                  .where(
                      and(
                          inArray(aiUsageEvents.itemId, recordingIds),
                          eq(aiUsageEvents.payerUserId, userId),
                      ),
                  )
            : [];
    const usageMap = new Map<string, typeof userUsage>();
    for (const usage of userUsage) {
        const group = usageMap.get(usage.itemId) ?? [];
        group.push(usage);
        usageMap.set(usage.itemId, group);
    }

    // The rows the recordings' owners hold.
    const userTranscriptions =
        recordingIds.length > 0
            ? await db
                  .select(getTableColumns(transcriptions))
                  .from(transcriptions)
                  .innerJoin(
                      recordings,
                      and(
                          eq(recordings.id, transcriptions.recordingId),
                          eq(recordings.userId, transcriptions.userId),
                      ),
                  )
                  .where(archivedRecordingCondition(scope))
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
                  .select(getTableColumns(aiEnhancements))
                  .from(aiEnhancements)
                  .innerJoin(
                      recordings,
                      and(
                          eq(recordings.id, aiEnhancements.itemId),
                          eq(recordings.userId, aiEnhancements.userId),
                      ),
                  )
                  .where(archivedRecordingCondition(scope))
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
        const group = enhancementMap.get(enhancement.itemId) ?? [];
        group.push({
            ...enhancement,
            summary: decryptText(enhancement.summary) ?? "",
            actionItems:
                decryptJsonField<string[]>(enhancement.actionItems) ?? [],
            keyPoints: decryptJsonField<string[]>(enhancement.keyPoints) ?? [],
        });
        enhancementMap.set(enhancement.itemId, group);
    }

    // Proposals and the follow-ups heard come along: a review half done is
    // part of the work, as Learn's open items are.
    const taskMap = await tasksForArchive(scope, recordingIds, {
        proposals: true,
    });
    const taskUpdateMap = await taskUpdatesForArchive(
        scope,
        recordingIds,
        new Set([...taskMap.values()].flat().map((task) => task.id)),
    );

    const archive = new ZipArchive({ zlib: { level: 6 } });
    // Count bytes as they flow through rather than re-reading the
    // finished archive back out of storage just to learn its size. In the
    // transform, not a `data` listener: that would start the stream
    // flowing before the storage attaches its writer (LocalStorage checks
    // its directory first), and whatever came out in between was counted
    // but never stored -- a corrupt archive whose download promised more
    // bytes than the file had.
    let fileSize = 0;
    const passthrough = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            fileSize += chunk.length;
            onProgress?.();
            callback(null, chunk);
        },
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
        /** Whose content it carries; a restore must not mix the two. */
        scope: ArchiveScope["kind"];
        createdAt: string;
        userId: string;
        recordings: ManifestRecording[];
        knowledge?: {
            people: number;
            attributions: number;
            rejections: number;
            corrections: number;
        };
        organization?: { folders: number; assignments: number };
        vocabulary?: {
            entityTypes: number;
            relationTypes: number;
            suggestedPhrases: number;
        };
        entities?: { entities: number; aliases: number; notes: number };
        facts?: { facts: number; evidence: number };
        learn?: { runs: number; items: number };
        aiProviderRates?: { count: number; path: string };
        /** Mail of the pile: each a directory with message.eml and mail.json. */
        mail?: {
            id: string;
            subject: string;
            occurredAt: string;
            path: string;
            /**
             * Whether message.eml is in the archive: a restore needs it. When
             * it could not be read, why, as for a recording's audio.
             */
            raw: { included: boolean; reason?: string };
        }[];
    } = {
        version: "2.2",
        scope: scope.kind,
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
            ...(scope.kind === "organization"
                ? {
                      owner: {
                          id: recording.userId,
                          name: recording.ownerName,
                          email: recording.ownerEmail,
                      },
                  }
                : {}),
            filename: decryptText(recording.title),
            startTime: recording.occurredAt.toISOString(),
            endTime: recording.endTime.toISOString(),
            duration: recording.duration,
            filesize: recording.filesize,
            deviceSn: recording.deviceSn,
            audio: { included: false, path: null },
            transcript: { included: false, path: null },
            transcripts: { included: false, path: null, count: 0 },
            summary: { included: false, path: null },
            summaries: { included: false, path: null, count: 0 },
            aiUsage: { included: false, path: null, count: 0 },
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
                            recordingId: item.itemId,
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

        const recordingUsage = usageMap.get(recording.id) ?? [];
        if (recordingUsage.length > 0) {
            const usagePath = `${folder}/ai-usage.json`;
            archive.append(
                Buffer.from(
                    JSON.stringify(
                        recordingUsage.map((usage) => ({
                            ...usage,
                            createdAt: usage.createdAt.toISOString(),
                        })),
                        null,
                        2,
                    ),
                ),
                { name: usagePath },
            );
            entry.aiUsage = {
                included: true,
                path: usagePath,
                count: recordingUsage.length,
            };
        }

        const recordingTaskList = taskMap.get(recording.id) ?? [];
        if (recordingTaskList.length > 0) {
            const tasksPath = `${folder}/tasks.json`;
            archive.append(
                Buffer.from(JSON.stringify(recordingTaskList, null, 2)),
                { name: tasksPath },
            );
            entry.tasks = {
                included: true,
                path: tasksPath,
                count: recordingTaskList.length,
            };
        }
        const recordingTaskUpdates = taskUpdateMap.get(recording.id) ?? [];
        if (recordingTaskUpdates.length > 0) {
            const updatesPath = `${folder}/task-updates.json`;
            archive.append(
                Buffer.from(JSON.stringify(recordingTaskUpdates, null, 2)),
                { name: updatesPath },
            );
            entry.taskUpdates = {
                included: true,
                path: updatesPath,
                count: recordingTaskUpdates.length,
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
    const knowledge = await collectKnowledgeBase(
        scope,
        archivedAssigneeIds(taskMap.values()),
    );
    if (
        knowledge.people.length > 0 ||
        knowledge.attributions.length > 0 ||
        knowledge.rejections.length > 0 ||
        knowledge.corrections.length > 0
    ) {
        archive.append(Buffer.from(JSON.stringify(knowledge, null, 2)), {
            name: "knowledge/people.json",
        });
        manifest.knowledge = {
            people: knowledge.people.length,
            attributions: knowledge.attributions.length,
            rejections: knowledge.rejections.length,
            corrections: knowledge.corrections.length,
        };
    }

    // Mail rides along: the raw message as it arrived (decrypted), and what
    // was read from it.
    const archivedMail = await collectArchivedMail(scope);
    for (const mail of archivedMail) {
        onProgress?.();
        const directory = `mail/${folderName({
            id: mail.id,
            occurredAt: new Date(mail.occurredAt),
        })}`;
        const { rawStoragePath, ...meta } = mail;
        let raw: { included: boolean; reason?: string } = {
            included: false,
            reason: "The message was not kept",
        };
        if (rawStoragePath) {
            try {
                archive.append(
                    decryptBuffer(
                        await sourceStorage.downloadFile(rawStoragePath),
                    ),
                    { name: `${directory}/message.eml` },
                );
                raw = { included: true };
            } catch (error) {
                const reason =
                    error instanceof Error ? error.message : String(error);
                console.error(
                    `[export] could not read the raw message of mail ${mail.id}:`,
                    reason,
                );
                raw = { included: false, reason };
            }
        }
        archive.append(Buffer.from(JSON.stringify(meta, null, 2)), {
            name: `${directory}/mail.json`,
        });
        manifest.mail ??= [];
        manifest.mail.push({
            id: mail.id,
            subject: mail.subject,
            occurredAt: mail.occurredAt,
            path: directory,
            raw,
        });
    }

    const organization = await collectFolderOrganization(
        scope,
        new Set([...recordingIds, ...archivedMail.map((mail) => mail.id)]),
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

    // The user's own vocabulary, and the phrases they suggested to the
    // Organization (only the phrase went there).
    const vocabulary = await collectVocabulary(userId);
    if (
        vocabulary.entityTypes.length > 0 ||
        vocabulary.relationTypes.length > 0 ||
        vocabulary.suggestedPhrases.length > 0
    ) {
        archive.append(Buffer.from(JSON.stringify(vocabulary, null, 2)), {
            name: "knowledge/vocabulary.json",
        });
        manifest.vocabulary = {
            entityTypes: vocabulary.entityTypes.length,
            relationTypes: vocabulary.relationTypes.length,
            suggestedPhrases: vocabulary.suggestedPhrases.length,
        };
    }

    // Entities, every name the user gave or taught, and their notes on the
    // Organization's entities; the Organization's entities and people those
    // point at come along, as referenced people do in `people.json`.
    const entities = await collectEntities(
        scope,
        new Set(knowledge.people.map((person) => person.id)),
    );
    if (
        entities.entities.length > 0 ||
        entities.aliases.length > 0 ||
        entities.notes.length > 0
    ) {
        archive.append(Buffer.from(JSON.stringify(entities, null, 2)), {
            name: "knowledge/entities.json",
        });
        manifest.entities = {
            entities: entities.entities.length,
            aliases: entities.aliases.length,
            notes: entities.notes.length,
        };
    }

    // Facts and where they were said, with the quotes; the Organization's
    // people and entities they name that the files above do not carry.
    const facts = await collectFacts(userId, {
        people: new Set([
            ...knowledge.people.map((person) => person.id),
            ...entities.people.map((person) => person.id),
        ]),
        entities: new Set(entities.entities.map((entity) => entity.id)),
    });
    if (facts.facts.length > 0) {
        archive.append(Buffer.from(JSON.stringify(facts, null, 2)), {
            name: "knowledge/facts.json",
        });
        manifest.facts = {
            facts: facts.facts.length,
            evidence: facts.evidence.length,
        };
    }

    // The user's Learn runs and what they proposed, the decisions taken
    // so far included. Dismissals are keyed hashes of this instance, which
    // no restore could match, so they stay behind.
    const learn = await collectLearn(userId);
    if (learn.runs.length > 0) {
        archive.append(Buffer.from(JSON.stringify(learn, null, 2)), {
            name: "knowledge/learn.json",
        });
        manifest.learn = {
            runs: learn.runs.length,
            items: learn.items.length,
        };
    }

    // Prices the user set on their provider cards. The cards themselves
    // stay behind (their keys are secrets), so each rate names the card
    // by what a restore would re-add: provider, model, endpoint.
    const priced = await db
        .select({
            provider: apiCredentials.provider,
            model: apiCredentials.defaultModel,
            baseUrl: apiCredentials.baseUrl,
            inputUsdPerMillion: apiCredentials.inputUsdPerMillion,
            outputUsdPerMillion: apiCredentials.outputUsdPerMillion,
            audioUsdPerHour: apiCredentials.audioUsdPerHour,
        })
        .from(apiCredentials)
        .where(
            and(
                eq(apiCredentials.userId, userId),
                or(
                    isNotNull(apiCredentials.inputUsdPerMillion),
                    isNotNull(apiCredentials.audioUsdPerHour),
                ),
            ),
        );
    if (priced.length > 0) {
        const path = "ai/provider-rates.json";
        archive.append(Buffer.from(JSON.stringify(priced, null, 2)), {
            name: path,
        });
        manifest.aiProviderRates = { count: priced.length, path };
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

// The scope's own tree: a person's Private folders and their filing in
// them, or the Organization's tree with every shared recording filed in it
// (an assignment row keeps its owner's id, whoever's folder it is in).
async function collectFolderOrganization(
    scope: ArchiveScope,
    activeRecordingIds: Set<string>,
): Promise<ArchivedFolderOrganization> {
    const userId = scopeUserId(scope);
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
                recordingId: recordingFolderAssignments.itemId,
                folderId: recordingFolderAssignments.folderId,
            })
            .from(recordingFolderAssignments)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, recordingFolderAssignments.folderId),
            )
            .where(
                scope.kind === "personal"
                    ? and(
                          eq(recordingFolderAssignments.userId, userId),
                          eq(recordingFolders.userId, userId),
                      )
                    : eq(recordingFolders.userId, userId),
            ),
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
        /** An Organization person the archive's own rows point at. */
        organization: boolean;
        /** Who first named it: in the Organization's archive only. */
        createdByUserId?: string | null;
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
        markedUnknown: boolean;
        confirmedByUserId: string | null;
    }[];
    /** "This speaker is not that person", as said by a human. */
    rejections: {
        transcriptionId: string;
        label: string;
        personId: string;
        createdAt: string;
    }[];
    /** The overlay on the archived transcripts, whose text stays as heard. */
    corrections: {
        transcriptionId: string;
        transcriptRevision: number;
        turnIndex: number;
        charStart: number;
        charEnd: number;
        heard: string;
        kind: string;
        targetPersonId: string | null;
        targetEntityId: string | null;
        replacement: string | null;
        preTicked: boolean;
        createdAt: string;
    }[];
}

// The transcripts an archive carries: those of its live recordings, as
// their owners hold them.
function archivedTranscriptIds(scope: ArchiveScope) {
    return db
        .select({ id: transcriptions.id })
        .from(transcriptions)
        .innerJoin(
            recordings,
            and(
                eq(recordings.id, transcriptions.recordingId),
                eq(recordings.userId, transcriptions.userId),
            ),
        )
        .where(archivedRecordingCondition(scope));
}

// The corrections an archive carries. A person's: their own, and of the
// Organization's on their own transcripts only those they made -- a
// recording they shared is still theirs, a colleague's work on it is not.
// The Organization's: its own, on the shared transcripts.
function exportedCorrections(scope: ArchiveScope) {
    if (scope.kind === "organization") {
        return and(
            eq(transcriptCorrections.userId, scope.orgUserId),
            inArray(
                transcriptCorrections.transcriptionId,
                archivedTranscriptIds(scope),
            ),
        );
    }
    return or(
        eq(transcriptCorrections.userId, scope.userId),
        and(
            orgOwnedCondition(transcriptCorrections.userId),
            eq(transcriptCorrections.createdByUserId, scope.userId),
            sql`${transcriptCorrections.transcriptionId} in (select ${transcriptions.id} from ${transcriptions} where ${transcriptions.userId} = ${scope.userId})`,
        ),
    );
}

// The rows naming speakers an archive carries: a person's own, or the
// owners' rows on the shared transcripts naming nobody or the
// Organization's people (a private person never leaves with them).
function exportedSpeakerRows(
    scope: ArchiveScope,
    table: typeof transcriptSpeakers | typeof transcriptSpeakerRejections,
): SQL | undefined {
    if (scope.kind === "personal") return eq(table.userId, scope.userId);
    return and(
        inArray(table.transcriptionId, archivedTranscriptIds(scope)),
        or(
            isNull(table.personId),
            sql`${table.personId} in (select ${people.id} from ${people} where ${orgOwnedCondition(people.userId)})`,
        ),
    );
}

// The knowledge base of one scope, decrypted for the archive.
//
// `primaryEmailHash` is deliberately not exported: it is derived from the
// email with a server secret and a restore can recompute it, while carrying
// it would pin the archive to one instance's secret.
async function collectKnowledgeBase(
    scope: ArchiveScope,
    /** People the archive names elsewhere: its tasks' assignees. */
    referencedPeople: readonly string[] = [],
): Promise<ArchivedKnowledgeBase> {
    const userId = scopeUserId(scope);
    const personColumns = {
        id: people.id,
        displayName: people.displayName,
        primaryEmail: people.primaryEmail,
        notes: people.notes,
        mergedIntoId: people.mergedIntoId,
        createdByUserId: people.createdByUserId,
        createdAt: people.createdAt,
    };
    const [peopleRows, attributionRows, rejectionRows, correctionRows] =
        await Promise.all([
            db
                .select(personColumns)
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
                    markedUnknown: transcriptSpeakers.markedUnknown,
                    confirmedByUserId: transcriptSpeakers.confirmedByUserId,
                })
                .from(transcriptSpeakers)
                .where(exportedSpeakerRows(scope, transcriptSpeakers)),
            db
                .select({
                    transcriptionId:
                        transcriptSpeakerRejections.transcriptionId,
                    label: transcriptSpeakerRejections.label,
                    personId: transcriptSpeakerRejections.personId,
                    createdAt: transcriptSpeakerRejections.createdAt,
                })
                .from(transcriptSpeakerRejections)
                .where(exportedSpeakerRows(scope, transcriptSpeakerRejections)),
            db
                .select({
                    transcriptionId: transcriptCorrections.transcriptionId,
                    transcriptRevision:
                        transcriptCorrections.transcriptRevision,
                    turnIndex: transcriptCorrections.turnIndex,
                    charStart: transcriptCorrections.charStart,
                    charEnd: transcriptCorrections.charEnd,
                    heard: transcriptCorrections.heard,
                    kind: transcriptCorrections.kind,
                    personId: transcriptCorrections.targetPersonId,
                    targetEntityId: transcriptCorrections.targetEntityId,
                    replacement: transcriptCorrections.replacement,
                    preTicked: transcriptCorrections.preTicked,
                    createdAt: transcriptCorrections.createdAt,
                })
                .from(transcriptCorrections)
                .where(exportedCorrections(scope)),
        ]);

    // Organization people the archive's rows name: a restore must still
    // know who spoke and whose a task is. A person carries those the person
    // created in full and only the name of a colleague's; both with this
    // person's own notes. Anything else the rows point at stays behind.
    const own = new Set(peopleRows.map((row) => row.id));
    const sharedIds = [
        ...new Set(
            [
                ...[
                    ...attributionRows,
                    ...rejectionRows,
                    ...correctionRows,
                ].map((row) => row.personId),
                ...referencedPeople,
            ].flatMap((personId) =>
                personId && !own.has(personId) ? [personId] : [],
            ),
        ),
    ];
    const sharedRows =
        sharedIds.length > 0
            ? await db
                  .select(personColumns)
                  .from(people)
                  .where(
                      and(
                          inArray(people.id, sharedIds),
                          orgOwnedCondition(people.userId),
                      ),
                  )
            : [];
    const overlay =
        sharedRows.length > 0
            ? await db
                  .select({
                      personId: personNotes.personId,
                      notes: personNotes.notes,
                  })
                  .from(personNotes)
                  .where(
                      and(
                          eq(personNotes.userId, userId),
                          inArray(
                              personNotes.personId,
                              sharedRows.map((row) => row.id),
                          ),
                      ),
                  )
            : [];
    const overlayByPerson = new Map(
        overlay.map((row) => [row.personId, row.notes]),
    );
    const archivedRows = [
        ...peopleRows.map((row) => ({ ...row, organization: false })),
        ...sharedRows.map((row) => ({
            ...row,
            primaryEmail:
                row.createdByUserId === userId ? row.primaryEmail : null,
            notes: overlayByPerson.get(row.id) ?? null,
            organization: true,
        })),
    ];

    return {
        people: archivedRows.map((row) => ({
            id: row.id,
            displayName: decryptText(row.displayName),
            primaryEmail: row.primaryEmail
                ? decryptText(row.primaryEmail)
                : null,
            notes: row.notes ? decryptText(row.notes) : null,
            mergedIntoId: row.mergedIntoId,
            organization: scope.kind === "organization" || row.organization,
            ...(scope.kind === "organization"
                ? { createdByUserId: row.createdByUserId }
                : {}),
            createdAt: row.createdAt.toISOString(),
        })),
        // Who confirmed a speaker is said only when it was this person.
        attributions:
            scope.kind === "personal"
                ? attributionRows.map((row) => ({
                      ...row,
                      confirmedByUserId:
                          row.confirmedByUserId === userId ? userId : null,
                  }))
                : attributionRows,
        rejections: rejectionRows.map((row) => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
        })),
        corrections: correctionRows.map(({ personId, ...row }) => ({
            ...row,
            targetPersonId: personId,
            heard: decryptText(row.heard),
            replacement: row.replacement ? decryptText(row.replacement) : null,
            createdAt: row.createdAt.toISOString(),
        })),
    };
}

interface ArchivedVocabulary {
    entityTypes: {
        key: string;
        label: string;
        adoptedAsKey: string | null;
        createdAt: string;
    }[];
    relationTypes: {
        key: string;
        label: string;
        subjectTypes: string[];
        objectTypes: string[];
        objectKind: string;
        cardinality: string;
        adoptedAsKey: string | null;
        createdAt: string;
    }[];
    suggestedPhrases: { phrase: string; status: string }[];
}

// The user's private vocabulary, decrypted. The entity types it relates are
// core keys, the user's own, or the Organization's, whose keys stay stable.
async function collectVocabulary(userId: string): Promise<ArchivedVocabulary> {
    const [entityRows, relationRows, phraseRows] = await Promise.all([
        db
            .select({
                key: knowledgeEntityTypes.key,
                label: knowledgeEntityTypes.label,
                adoptedAsKey: knowledgeEntityTypes.adoptedAsKey,
                createdAt: knowledgeEntityTypes.createdAt,
            })
            .from(knowledgeEntityTypes)
            .where(eq(knowledgeEntityTypes.userId, userId)),
        db
            .select({
                key: knowledgeRelationTypes.key,
                label: knowledgeRelationTypes.label,
                subjectTypes: knowledgeRelationTypes.subjectTypes,
                objectTypes: knowledgeRelationTypes.objectTypes,
                objectKind: knowledgeRelationTypes.objectKind,
                cardinality: knowledgeRelationTypes.cardinality,
                adoptedAsKey: knowledgeRelationTypes.adoptedAsKey,
                createdAt: knowledgeRelationTypes.createdAt,
            })
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.userId, userId)),
        db
            .select({
                phrase: knowledgeVocabularyProposals.phrase,
                status: knowledgeVocabularyProposals.status,
            })
            .from(knowledgeVocabularyProposalVotes)
            .innerJoin(
                knowledgeVocabularyProposals,
                eq(
                    knowledgeVocabularyProposals.id,
                    knowledgeVocabularyProposalVotes.proposalId,
                ),
            )
            .where(eq(knowledgeVocabularyProposalVotes.userId, userId)),
    ]);
    return {
        entityTypes: entityRows.map((row) => ({
            ...row,
            label: decryptText(row.label),
            createdAt: row.createdAt.toISOString(),
        })),
        relationTypes: relationRows.map((row) => ({
            ...row,
            label: decryptText(row.label),
            createdAt: row.createdAt.toISOString(),
        })),
        suggestedPhrases: phraseRows.map((row) => ({
            phrase: decryptText(row.phrase),
            status: row.status,
        })),
    };
}

interface ArchivedEntities {
    entities: {
        id: string;
        typeKey: string;
        name: string;
        description: string | null;
        mergedIntoId: string | null;
        /** An Organization entity the archive's knowledge points at. */
        organization: boolean;
        /** Who first named it: in the Organization's archive only. */
        createdByUserId?: string | null;
        createdAt: string;
    }[];
    aliases: {
        personId: string | null;
        entityId: string | null;
        kind: string;
        text: string;
        language: string | null;
        provider: string | null;
        createdAt: string;
    }[];
    /** The user's private notes on Organization entities. */
    notes: { entityId: string; notes: string }[];
    /** Organization people the aliases name, when `people.json` has none. */
    people: { id: string; displayName: string; mergedIntoId: string | null }[];
}

// The names a person taught: their own, and those of the Organization's
// they taught before sharing. The Organization's: its own.
function exportedAliases(scope: ArchiveScope) {
    if (scope.kind === "organization") {
        return eq(knowledgeAliases.userId, scope.orgUserId);
    }
    return or(
        eq(knowledgeAliases.userId, scope.userId),
        and(
            orgOwnedCondition(knowledgeAliases.userId),
            eq(knowledgeAliases.createdByUserId, scope.userId),
        ),
    );
}

async function collectEntities(
    scope: ArchiveScope,
    archivedPeople: ReadonlySet<string>,
): Promise<ArchivedEntities> {
    const userId = scopeUserId(scope);
    const entityColumns = {
        id: knowledgeEntities.id,
        typeKey: knowledgeEntities.typeKey,
        name: knowledgeEntities.name,
        description: knowledgeEntities.description,
        mergedIntoId: knowledgeEntities.mergedIntoId,
        createdByUserId: knowledgeEntities.createdByUserId,
        createdAt: knowledgeEntities.createdAt,
    };
    const [ownRows, aliasRows, noteRows, correctionRows] = await Promise.all([
        db
            .select(entityColumns)
            .from(knowledgeEntities)
            .where(eq(knowledgeEntities.userId, userId)),
        db
            .select({
                personId: knowledgeAliases.personId,
                entityId: knowledgeAliases.entityId,
                kind: knowledgeAliases.kind,
                text: knowledgeAliases.text,
                language: knowledgeAliases.language,
                provider: knowledgeAliases.provider,
                createdAt: knowledgeAliases.createdAt,
            })
            .from(knowledgeAliases)
            .where(exportedAliases(scope)),
        db
            .select({
                entityId: knowledgeEntityNotes.entityId,
                notes: knowledgeEntityNotes.notes,
            })
            .from(knowledgeEntityNotes)
            .where(eq(knowledgeEntityNotes.userId, userId)),
        db
            .select({ entityId: transcriptCorrections.targetEntityId })
            .from(transcriptCorrections)
            .where(
                and(
                    exportedCorrections(scope),
                    isNotNull(transcriptCorrections.targetEntityId),
                ),
            ),
    ]);

    const own = new Set(ownRows.map((row) => row.id));
    const referencedIds = [
        ...new Set(
            [...aliasRows, ...noteRows, ...correctionRows].flatMap((row) =>
                row.entityId && !own.has(row.entityId) ? [row.entityId] : [],
            ),
        ),
    ];
    const referencedRows =
        referencedIds.length > 0
            ? await db
                  .select(entityColumns)
                  .from(knowledgeEntities)
                  .where(
                      and(
                          inArray(knowledgeEntities.id, referencedIds),
                          orgOwnedCondition(knowledgeEntities.userId),
                      ),
                  )
            : [];
    const personIds = [
        ...new Set(
            aliasRows.flatMap((row) =>
                row.personId && !archivedPeople.has(row.personId)
                    ? [row.personId]
                    : [],
            ),
        ),
    ];
    const personRows =
        personIds.length > 0
            ? await db
                  .select({
                      id: people.id,
                      displayName: people.displayName,
                      mergedIntoId: people.mergedIntoId,
                  })
                  .from(people)
                  .where(
                      and(
                          inArray(people.id, personIds),
                          orgOwnedCondition(people.userId),
                      ),
                  )
            : [];

    // A person's archive describes an Organization entity only when the
    // person created it; a colleague's goes by its name alone.
    const describes = (row: (typeof ownRows)[number], organization: boolean) =>
        scope.kind === "organization" ||
        !organization ||
        row.createdByUserId === userId;
    const archived = (
        row: (typeof ownRows)[number],
        organization: boolean,
    ) => ({
        id: row.id,
        typeKey: row.typeKey,
        name: decryptText(row.name),
        description:
            row.description && describes(row, organization)
                ? decryptText(row.description)
                : null,
        mergedIntoId: row.mergedIntoId,
        organization: scope.kind === "organization" || organization,
        ...(scope.kind === "organization"
            ? { createdByUserId: row.createdByUserId }
            : {}),
        createdAt: row.createdAt.toISOString(),
    });
    return {
        entities: [
            ...ownRows.map((row) => archived(row, false)),
            ...referencedRows.map((row) => archived(row, true)),
        ],
        aliases: aliasRows.map((row) => ({
            ...row,
            text: decryptText(row.text),
            createdAt: row.createdAt.toISOString(),
        })),
        notes: noteRows.map((row) => ({
            entityId: row.entityId,
            notes: decryptText(row.notes),
        })),
        people: personRows.map((row) => ({
            ...row,
            displayName: decryptText(row.displayName),
        })),
    };
}

interface ArchivedLearn {
    runs: {
        id: string;
        recordingId: string;
        transcriptionId: string | null;
        view: string;
        trigger: string;
        status: string;
        path: string | null;
        provider: string | null;
        model: string | null;
        transcriptRevision: number;
        stats: Record<string, number> | null;
        createdAt: string;
        finishedAt: string | null;
    }[];
    items: {
        runId: string;
        kind: string;
        preTicked: boolean;
        decision: string | null;
        dependsOnLabel: string | null;
        payload: unknown;
    }[];
}

// The runs proposing knowledge in the user's own scope: on their private
// recordings. The Organization's runs on a recording they shared are the
// Organization's, and go when it is withdrawn.
async function collectLearn(userId: string): Promise<ArchivedLearn> {
    const runs = await db
        .select({
            id: learnRuns.id,
            recordingId: learnRuns.itemId,
            transcriptionId: learnRuns.transcriptionId,
            view: learnRuns.view,
            trigger: learnRuns.trigger,
            status: learnRuns.status,
            path: learnRuns.path,
            provider: learnRuns.provider,
            model: learnRuns.model,
            transcriptRevision: learnRuns.transcriptRevision,
            stats: learnRuns.stats,
            createdAt: learnRuns.createdAt,
            finishedAt: learnRuns.finishedAt,
        })
        .from(learnRuns)
        .where(eq(learnRuns.scopeUserId, userId));
    const items =
        runs.length > 0
            ? await db
                  .select({
                      runId: learnReviewItems.runId,
                      kind: learnReviewItems.kind,
                      preTicked: learnReviewItems.preTicked,
                      decision: learnReviewItems.decision,
                      dependsOnLabel: learnReviewItems.dependsOnLabel,
                      payload: learnReviewItems.payload,
                  })
                  .from(learnReviewItems)
                  .where(
                      inArray(
                          learnReviewItems.runId,
                          runs.map((run) => run.id),
                      ),
                  )
            : [];
    return {
        runs: runs.map((run) => ({
            ...run,
            createdAt: run.createdAt.toISOString(),
            finishedAt: run.finishedAt?.toISOString() ?? null,
        })),
        items: items.map((item) => ({
            ...item,
            payload: decryptJsonField(item.payload),
        })),
    };
}

interface ArchivedFacts {
    facts: {
        id: string;
        subjectPersonId: string | null;
        subjectEntityId: string | null;
        relationKey: string;
        objectPersonId: string | null;
        objectEntityId: string | null;
        objectLiteral: string | null;
        origin: string;
        replacedByFactId: string | null;
        createdAt: string;
    }[];
    evidence: {
        factId: string;
        transcriptionId: string | null;
        recordingId: string;
        transcriptRevision: number;
        startMs: number | null;
        endMs: number | null;
        segmentIndex: number | null;
        charStart: number | null;
        charEnd: number | null;
        speakerLabel: string | null;
        dependsOnSpeaker: boolean;
        quote: string;
        status: string;
        confirmedAt: string;
    }[];
    /** Organization people and entities the facts name, not archived elsewhere. */
    people: { id: string; displayName: string; mergedIntoId: string | null }[];
    entities: {
        id: string;
        typeKey: string;
        name: string;
        mergedIntoId: string | null;
    }[];
}

async function collectFacts(
    userId: string,
    archived: { people: ReadonlySet<string>; entities: ReadonlySet<string> },
): Promise<ArchivedFacts> {
    const [factRows, evidenceRows] = await Promise.all([
        db
            .select({
                id: knowledgeFacts.id,
                subjectPersonId: knowledgeFacts.subjectPersonId,
                subjectEntityId: knowledgeFacts.subjectEntityId,
                relationKey: knowledgeFacts.relationKey,
                objectPersonId: knowledgeFacts.objectPersonId,
                objectEntityId: knowledgeFacts.objectEntityId,
                objectLiteral: knowledgeFacts.objectLiteral,
                origin: knowledgeFacts.origin,
                replacedByFactId: knowledgeFacts.replacedByFactId,
                createdAt: knowledgeFacts.createdAt,
            })
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.userId, userId)),
        db
            .select({
                factId: knowledgeFactEvidence.factId,
                transcriptionId: knowledgeFactEvidence.transcriptionId,
                recordingId: knowledgeFactEvidence.itemId,
                transcriptRevision: knowledgeFactEvidence.transcriptRevision,
                startMs: knowledgeFactEvidence.startMs,
                endMs: knowledgeFactEvidence.endMs,
                segmentIndex: knowledgeFactEvidence.segmentIndex,
                charStart: knowledgeFactEvidence.charStart,
                charEnd: knowledgeFactEvidence.charEnd,
                speakerLabel: knowledgeFactEvidence.speakerLabel,
                dependsOnSpeaker: knowledgeFactEvidence.dependsOnSpeaker,
                quote: knowledgeFactEvidence.quote,
                status: knowledgeFactEvidence.status,
                confirmedAt: knowledgeFactEvidence.confirmedAt,
            })
            .from(knowledgeFactEvidence)
            .where(eq(knowledgeFactEvidence.userId, userId)),
    ]);
    const missing = (ids: (string | null)[], have: ReadonlySet<string>) => [
        ...new Set(ids.filter((id): id is string => !!id && !have.has(id))),
    ];
    const personIds = missing(
        factRows.flatMap((row) => [row.subjectPersonId, row.objectPersonId]),
        archived.people,
    );
    const entityIds = missing(
        factRows.flatMap((row) => [row.subjectEntityId, row.objectEntityId]),
        archived.entities,
    );
    const personRows =
        personIds.length > 0
            ? await db
                  .select({
                      id: people.id,
                      displayName: people.displayName,
                      mergedIntoId: people.mergedIntoId,
                  })
                  .from(people)
                  .where(
                      and(
                          inArray(people.id, personIds),
                          orgOwnedCondition(people.userId),
                      ),
                  )
            : [];
    const entityRows =
        entityIds.length > 0
            ? await db
                  .select({
                      id: knowledgeEntities.id,
                      typeKey: knowledgeEntities.typeKey,
                      name: knowledgeEntities.name,
                      mergedIntoId: knowledgeEntities.mergedIntoId,
                  })
                  .from(knowledgeEntities)
                  .where(
                      and(
                          inArray(knowledgeEntities.id, entityIds),
                          orgOwnedCondition(knowledgeEntities.userId),
                      ),
                  )
            : [];
    return {
        facts: factRows.map((row) => ({
            ...row,
            objectLiteral: row.objectLiteral
                ? decryptText(row.objectLiteral)
                : null,
            createdAt: row.createdAt.toISOString(),
        })),
        evidence: evidenceRows.map((row) => ({
            ...row,
            quote: decryptText(row.quote),
            confirmedAt: row.confirmedAt.toISOString(),
        })),
        people: personRows.map((row) => ({
            ...row,
            displayName: decryptText(row.displayName),
        })),
        entities: entityRows.map((row) => ({
            ...row,
            name: decryptText(row.name),
        })),
    };
}
