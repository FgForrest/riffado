import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { insertAudioItem } from "@/db/items";
import {
    accounts,
    aiUsageEvents,
    apiCredentials,
    learnReviewItems,
    learnRuns,
    mailAddresses,
    recordingFolders,
    recordingTasks,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    userSettings,
    users,
} from "@/db/schema";
import {
    defaultTemplateConfig,
    seedTemplate,
    type TemplateConfiguration,
} from "@/lib/ai/prompt-templates";
import { PRICE_SOURCE } from "@/lib/ai/published-rates";
import { setDefaultTranscriptionProvider } from "@/lib/ai/set-default-transcription";
import { SUMMARY_TEMPLATE_KIND } from "@/lib/ai/summary-presets";
import { encrypt } from "@/lib/encryption";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import {
    addRecordingToFolder,
    createFolder,
    ensureRootFolders,
} from "@/lib/folders/folders";
import { addAlias } from "@/lib/knowledge/aliases";
import { createEntity } from "@/lib/knowledge/entities";
import { confirmManualFact, type FactObject } from "@/lib/knowledge/facts";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { createPerson } from "@/lib/knowledge/people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
import { buildRecordingStorageFilename } from "@/lib/recordings/filename";
import {
    upsertEnhancement,
    upsertTranscription,
} from "@/lib/transcription/persist";
import {
    renderTurnsAsText,
    type TranscriptTurn,
} from "@/lib/transcription/turns";
import {
    DEMO_FACTS,
    DEMO_ORG_FOLDERS,
    DEMO_PEOPLE,
    DEMO_PRIVATE_FOLDERS,
    DEMO_PROVIDERS,
    DEMO_RECORDINGS,
    DEMO_SUMMARY_TEMPLATES,
    DEMO_THINGS,
    DEMO_USERS,
    type DemoCorrection,
    type DemoFactRef,
    type DemoLearnItem,
    type DemoPersonKey,
    type DemoRecording,
    type DemoThingKey,
    type DemoTurn,
    type DemoUserKey,
} from "./fixtures";

/** One audio file the seed expects on disk, for the caller to create. */
export interface DemoAudioFile {
    /** Relative to the app's `LOCAL_STORAGE_PATH`. */
    storagePath: string;
    durationSeconds: number;
}

export interface DemoSeedResult {
    users: Record<DemoUserKey, string>;
    orgUserId: string;
    recordings: Record<string, string>;
    audio: DemoAudioFile[];
}

const DEVICE_SN = "PLA-NTP-DEMO-0001";
const AUDIO_EXTENSION = "ogg";
const DAY_MS = 24 * 60 * 60 * 1000;

interface Scope {
    userId: string;
    people: Map<DemoPersonKey, string>;
    things: Map<DemoThingKey, string>;
}

/**
 * Replace everything in the database with the user guide's demo data.
 * Deletes every account first: run it only against the guide's own stack.
 */
export async function seedUserGuideDemo(
    now = new Date(),
): Promise<DemoSeedResult> {
    // The demo starts from nothing, mail addresses included.
    await db.delete(mailAddresses);
    await db.delete(users);
    await seedCoreVocabulary();
    const orgUserId = await ensureOrgAccount();
    if (!orgUserId) {
        throw new Error(
            "Set ORG_ACCOUNT_EMAIL and ORG_ACCOUNT_PASSWORD for the demo",
        );
    }

    const userIds = {} as Record<DemoUserKey, string>;
    for (const user of DEMO_USERS) {
        userIds[user.key] = await createUser(user);
    }
    const alex = userIds.alex;

    const alexScope = await seedAlmanac(alex);
    const priyaScope: Scope = {
        userId: userIds.priya,
        people: new Map([
            [
                "priya",
                (
                    await createPerson({
                        userId: userIds.priya,
                        displayName: "Priya Raman",
                        primaryEmail: "priya@example.com",
                    })
                ).id,
            ],
        ]),
        things: new Map(),
    };
    const scopes: Record<DemoUserKey, Scope> = {
        alex: alexScope,
        priya: priyaScope,
    };

    await seedProviders(alex);
    await seedSettings(alex);
    await seedSettings(userIds.priya);

    const privateFolders = new Map<string, Map<string, string>>();
    for (const userId of Object.values(userIds)) {
        await ensureRootFolders(userId);
        privateFolders.set(
            userId,
            await createFolderTree(
                userId,
                await rootFolderId(userId, "private"),
                DEMO_PRIVATE_FOLDERS,
            ),
        );
    }
    const orgFolders = await createFolderTree(
        alex,
        await rootFolderId(orgUserId, "public"),
        DEMO_ORG_FOLDERS,
    );

    const recordingIds: Record<string, string> = {};
    const audio: DemoAudioFile[] = [];
    for (const fixture of DEMO_RECORDINGS) {
        const scope = scopes[fixture.owner];
        const seeded = await seedRecording(fixture, scope, now);
        recordingIds[fixture.key] = seeded.recordingId;
        audio.push(seeded.audio);

        const folders = privateFolders.get(scope.userId);
        for (const path of fixture.privateFolders ?? []) {
            await addRecordingToFolder({
                userId: scope.userId,
                recordingId: seeded.recordingId,
                folderId: folderAt(folders, path),
            });
        }
        for (const path of fixture.orgFolders ?? []) {
            await addRecordingToFolder({
                userId: scope.userId,
                recordingId: seeded.recordingId,
                folderId: folderAt(orgFolders, path),
            });
        }
    }

    await db.transaction(async (tx) => {
        await bumpScopeInTx(tx, [alex, userIds.priya, orgUserId]);
    });

    return { users: userIds, orgUserId, recordings: recordingIds, audio };
}

async function createUser(user: (typeof DEMO_USERS)[number]): Promise<string> {
    const [created] = await db
        .insert(users)
        .values({ email: user.email, name: user.name, emailVerified: true })
        .returning({ id: users.id });
    if (!created) throw new Error(`User ${user.email} was not created`);
    await db.insert(accounts).values({
        userId: created.id,
        accountId: created.id,
        providerId: "credential",
        password: await hashPassword(user.password),
    });
    return created.id;
}

async function seedAlmanac(userId: string): Promise<Scope> {
    const scope: Scope = { userId, people: new Map(), things: new Map() };
    for (const person of DEMO_PEOPLE) {
        const created = await createPerson({
            userId,
            displayName: person.name,
            primaryEmail: person.email,
            notes: person.notes,
        });
        scope.people.set(person.key, created.id);
        for (const nickname of person.nicknames ?? []) {
            await addAlias(userId, { personId: created.id }, nickname);
        }
    }
    for (const thing of DEMO_THINGS) {
        const created = await createEntity(userId, {
            typeKey: thing.typeKey,
            name: thing.name,
            description: thing.description,
        });
        scope.things.set(thing.key, created.id);
        for (const nickname of thing.nicknames ?? []) {
            await addAlias(userId, { entityId: created.id }, nickname);
        }
    }
    for (const fact of DEMO_FACTS) {
        await confirmManualFact(userId, {
            subject: target(scope, fact.subject),
            relationKey: fact.relationKey,
            object: factObject(scope, fact.object),
        });
    }
    return scope;
}

function target(
    scope: Scope,
    ref: DemoFactRef,
): { personId: string } | { entityId: string } {
    if ("person" in ref) return { personId: personId(scope, ref.person) };
    if ("thing" in ref) return { entityId: thingId(scope, ref.thing) };
    throw new Error("A subject cannot be text");
}

function factObject(scope: Scope, ref: DemoFactRef): FactObject {
    return "literal" in ref ? { literal: ref.literal } : target(scope, ref);
}

function personId(scope: Scope, key: DemoPersonKey): string {
    const id = scope.people.get(key);
    if (!id) throw new Error(`No demo person ${key} in this scope`);
    return id;
}

function thingId(scope: Scope, key: DemoThingKey): string {
    const id = scope.things.get(key);
    if (!id) throw new Error(`No demo thing ${key} in this scope`);
    return id;
}

type CredentialIds = Map<(typeof DEMO_PROVIDERS)[number]["key"], string>;

async function seedProviders(userId: string): Promise<CredentialIds> {
    const ids: CredentialIds = new Map();
    for (const provider of DEMO_PROVIDERS) {
        const [row] = await db
            .insert(apiCredentials)
            .values({
                userId,
                provider: provider.provider,
                apiKey: encrypt(`demo-${provider.key}-key`),
                baseUrl: provider.baseUrl,
                defaultModel: provider.model,
                isDefaultEnhancement: provider.summaries ?? false,
                isDefaultLearn: provider.learn ?? false,
                inputUsdPerMillion: provider.inputUsdPerMillion?.toFixed(6),
                outputUsdPerMillion: provider.outputUsdPerMillion?.toFixed(6),
                audioUsdPerHour: provider.audioUsdPerHour?.toFixed(6),
            })
            .returning({ id: apiCredentials.id });
        if (!row) throw new Error(`Provider ${provider.key} was not created`);
        ids.set(provider.key, row.id);
        if (provider.transcription) {
            await setDefaultTranscriptionProvider(userId, row.id);
        }
    }
    return ids;
}

async function seedSettings(userId: string): Promise<void> {
    const summaryTemplates: TemplateConfiguration = {
        selectedPrompt: "meeting-notes",
        templates: [
            ...defaultTemplateConfig(SUMMARY_TEMPLATE_KIND).templates,
            ...DEMO_SUMMARY_TEMPLATES.map((template) => ({
                ...seedTemplate(template.id),
                name: template.name,
                prompt: template.prompt,
                createdAt: new Date().toISOString(),
            })),
        ],
    };
    const values = {
        onboardingCompleted: true,
        autoSyncEnabled: false,
        syncOnMount: false,
        syncOnVisibilityChange: false,
        syncNotifications: false,
        autoTranscribe: false,
        autoSummarize: false,
        autoLearn: false,
        autoDetectTopics: false,
        summaryPrompt: encryptJsonField(summaryTemplates),
        summaryMultiPass: true,
        summaryMultiPassRounds: 3,
        retentionLocalAudioDays: 365,
        retentionRemoteOriginalDays: 180,
        backupFrequency: "weekly" as const,
    };
    await db
        .insert(userSettings)
        .values({ userId, ...values })
        .onConflictDoUpdate({ target: userSettings.userId, set: values });
}

async function rootFolderId(
    userId: string,
    kind: "private" | "public",
): Promise<string> {
    const [root] = await db
        .select({ id: recordingFolders.id })
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.userId, userId),
                eq(recordingFolders.kind, kind),
            ),
        )
        .limit(1);
    if (!root) throw new Error(`No ${kind} root folder for ${userId}`);
    return root.id;
}

async function createFolderTree(
    actorUserId: string,
    rootId: string,
    paths: readonly string[],
): Promise<Map<string, string>> {
    const ids = new Map<string, string>([["", rootId]]);
    for (const path of paths) {
        const slash = path.lastIndexOf("/");
        const parentPath = slash < 0 ? "" : path.slice(0, slash);
        const parentId = ids.get(parentPath);
        if (!parentId)
            throw new Error(`Folder ${parentPath} comes after ${path}`);
        const folder = await createFolder({
            userId: actorUserId,
            parentId,
            name: path.slice(slash + 1),
        });
        ids.set(path, folder.id);
    }
    return ids;
}

function folderAt(
    folders: Map<string, string> | undefined,
    path: string,
): string {
    const id = folders?.get(path);
    if (!id) throw new Error(`No demo folder ${path}`);
    return id;
}

/** Spread the turns over the recording, longer turns taking longer. */
function timeTurns(
    turns: readonly DemoTurn[],
    durationMs: number,
): TranscriptTurn[] {
    const start = 2_000;
    const span = durationMs - start - 5_000;
    const total = turns.reduce((sum, turn) => sum + turn.text.length, 0);
    let at = start;
    return turns.map((turn) => {
        const length = Math.round((span * turn.text.length) / total);
        const timed = {
            speaker: turn.speaker,
            startMs: at,
            endMs: at + length - 600,
            text: turn.text,
        };
        at += length;
        return timed;
    });
}

/** Deterministic speech-like waveform peaks in [0, 1]. */
function waveformPeaks(seed: string, count = 500): number[] {
    let state = 2166136261;
    for (const char of seed)
        state = Math.imul(state ^ char.charCodeAt(0), 16777619);
    const random = () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return Array.from({ length: count }, (_, i) => {
        const phrase =
            0.55 + 0.45 * Math.abs(Math.sin(i / 7.3) * Math.sin(i / 2.9));
        return Math.min(1, Math.max(0.04, phrase * (0.35 + random() * 0.65)));
    });
}

function md5Of(seed: string): string {
    let hex = "";
    let state = 0;
    for (const char of `${seed}-demo-audio`)
        state = (state * 31 + char.charCodeAt(0)) >>> 0;
    while (hex.length < 32) {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        hex += state.toString(16).padStart(8, "0");
    }
    return hex.slice(0, 32);
}

async function seedRecording(
    fixture: DemoRecording,
    scope: Scope,
    now: Date,
): Promise<{ recordingId: string; audio: DemoAudioFile }> {
    const userId = scope.userId;
    const startTime = new Date(now.getTime() - fixture.daysAgo * DAY_MS);
    startTime.setHours(fixture.hour, 4, 0, 0);
    const durationMs = fixture.durationMinutes * 60_000;
    const storageFilename = buildRecordingStorageFilename(
        fixture.title,
        AUDIO_EXTENSION,
    );
    const storagePath = `${userId}/${storageFilename}`;
    const fileMd5 = md5Of(fixture.key);
    const uploaded = fixture.origin !== "plaud";

    const { id: recordingId } = await insertAudioItem(db, {
        userId,
        deviceSn: uploaded ? "local" : DEVICE_SN,
        plaudFileId: uploaded
            ? `uploaded-demo-${fixture.key}`
            : `demo-${fixture.key}`,
        title: encryptText(fixture.title),
        duration: durationMs,
        occurredAt: startTime,
        endTime: new Date(startTime.getTime() + durationMs),
        filesize: fixture.durationMinutes * 60 * 2_000,
        fileMd5,
        storageType: "local",
        storagePath,
        storageFilename,
        plaudVersion: "1",
        downloadedAt: startTime,
        waveformPeaks: waveformPeaks(fixture.key),
    });
    const audio = {
        storagePath,
        durationSeconds: fixture.durationMinutes * 60,
    };

    const transcript = fixture.transcript;
    if (!transcript) return { recordingId, audio };

    const turns = timeTurns(transcript.turns, durationMs);
    const written = await upsertTranscription({
        userId,
        recordingId,
        text: renderTurnsAsText(turns),
        detectedLanguage: transcript.language,
        source: "riffado",
        provider: transcript.provider,
        model: transcript.model,
        turns,
        audioMd5: fileMd5,
    });
    if (!written.committed)
        throw new Error(`Transcript of ${fixture.key} refused`);
    const [transcription] = await db
        .select({ id: transcriptions.id, revision: transcriptions.revision })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
            ),
        )
        .limit(1);
    if (!transcription) throw new Error(`Transcript of ${fixture.key} missing`);

    if (transcript.topics) {
        const topics = transcript.topics.map((topic, index, all) => {
            const next = all[index + 1];
            return {
                title: topic.title,
                fromMs: turns[topic.atTurn]?.startMs ?? 0,
                toMs: next
                    ? (turns[next.atTurn]?.startMs ?? durationMs)
                    : (turns.at(-1)?.endMs ?? durationMs),
            };
        });
        await db
            .update(transcriptions)
            .set({
                topics: encryptJsonField({
                    topics,
                    provider: "Claude Code",
                    model: "claude-sonnet-5",
                    templateId: "default",
                    generatedAt: startTime.toISOString(),
                }),
            })
            .where(eq(transcriptions.id, transcription.id));
    }

    for (const [label, speaker] of Object.entries(transcript.speakers)) {
        if (speaker.status === "open") continue;
        const firstTurn = turns.find((turn) => turn.speaker === label);
        await db.insert(transcriptSpeakers).values({
            userId,
            transcriptionId: transcription.id,
            label,
            personId:
                "person" in speaker ? personId(scope, speaker.person) : null,
            source: speaker.status === "suggested" ? "llm" : "user",
            status: speaker.status === "suggested" ? "suggested" : "confirmed",
            confidence:
                speaker.status === "suggested" ? speaker.confidence : null,
            evidenceStartMs: firstTurn?.startMs ?? null,
            markedUnknown: speaker.status === "unknown",
            confirmedByUserId: speaker.status === "suggested" ? null : userId,
        });
    }

    for (const correction of transcript.corrections ?? []) {
        for (const anchor of anchorsOf(turns, correction.heard)) {
            await db.insert(transcriptCorrections).values({
                userId,
                transcriptionId: transcription.id,
                transcriptRevision: transcription.revision,
                ...anchor,
                heard: encryptText(correction.heard),
                heardHmac: domainLookupHash(
                    "correction-heard",
                    correction.heard,
                ),
                kind: "correct",
                ...correctionTarget(scope, correction),
                replacement: encryptText(correction.replacement),
                createdByUserId: userId,
            });
        }
    }

    if (fixture.summary) {
        const summary = fixture.summary;
        const done = await upsertEnhancement({
            userId,
            recordingId,
            transcriptionId: transcription.id,
            summary: summary.markdown,
            keyPoints: summary.keyPoints,
            actionItems: summary.actionItems,
            source: "riffado",
            provider: summary.provider,
            model: summary.model,
            multiPass: summary.multiPass
                ? {
                      roundsRequested: summary.multiPass.rounds,
                      passesUsed: summary.multiPass.used,
                      merged: summary.multiPass.merged,
                  }
                : undefined,
        });
        if (!done.committed)
            throw new Error(`Summary of ${fixture.key} refused`);
    }

    await seedTasks(fixture, scope, recordingId, turns, now);

    if (fixture.learn) {
        await seedLearnRun(
            fixture.learn,
            scope,
            recordingId,
            transcription,
            turns,
        );
    }

    for (const cost of fixture.costs ?? []) {
        await db.insert(aiUsageEvents).values({
            itemId: recordingId,
            userId,
            payerUserId: userId,
            operation: cost.operation,
            provider: cost.provider,
            model: cost.model,
            inputTokens: cost.inputTokens ?? null,
            outputTokens: cost.outputTokens ?? null,
            audioSeconds: cost.audioSeconds?.toFixed(3) ?? null,
            costUsd: cost.costUsd.toFixed(9),
            priceSource: PRICE_SOURCE,
            createdAt: startTime,
        });
    }

    return { recordingId, audio };
}

function anchorsOf(
    turns: readonly TranscriptTurn[],
    heard: string,
): { turnIndex: number; charStart: number; charEnd: number }[] {
    const anchors = [];
    for (const [turnIndex, turn] of turns.entries()) {
        let from = turn.text.indexOf(heard);
        while (from >= 0) {
            anchors.push({
                turnIndex,
                charStart: from,
                charEnd: from + heard.length,
            });
            from = turn.text.indexOf(heard, from + heard.length);
        }
    }
    if (anchors.length === 0) throw new Error(`"${heard}" is never said`);
    return anchors;
}

function correctionTarget(
    scope: Scope,
    correction: DemoCorrection,
): { targetPersonId: string } | { targetEntityId: string } {
    return "person" in correction.target
        ? { targetPersonId: personId(scope, correction.target.person) }
        : { targetEntityId: thingId(scope, correction.target.thing) };
}

function quoteOf(turn: TranscriptTurn | undefined): string | null {
    if (!turn) return null;
    const words = turn.text.split(/\s+/);
    return words.length > 14 ? `${words.slice(0, 14).join(" ")}…` : turn.text;
}

function isoDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

async function seedTasks(
    fixture: DemoRecording,
    scope: Scope,
    recordingId: string,
    turns: readonly TranscriptTurn[],
    now: Date,
): Promise<void> {
    const userId = scope.userId;
    for (const [position, task] of (fixture.tasks ?? []).entries()) {
        const turn = task.atTurn === undefined ? undefined : turns[task.atTurn];
        const settled = task.status !== "proposed";
        const decidedAt = new Date(now.getTime() - DAY_MS);
        await db.insert(recordingTasks).values({
            itemId: recordingId,
            userId,
            status: task.status,
            text: encryptText(task.text),
            assigneePersonId: task.assignee
                ? personId(scope, task.assignee)
                : null,
            assigneeHint: encryptText(task.assigneeHint ?? null),
            dueDate:
                task.dueInDays === undefined
                    ? null
                    : isoDay(new Date(now.getTime() + task.dueInDays * DAY_MS)),
            duePhrase: encryptText(task.duePhrase ?? null),
            quote: encryptText(quoteOf(turn)),
            evidenceStartMs: turn?.startMs ?? null,
            source: "riffado",
            ticked: task.ticked ?? true,
            position,
            createdByUserId: userId,
            acceptedAt: settled ? decidedAt : null,
            acceptedByUserId: settled ? userId : null,
            assignedAt: settled ? decidedAt : null,
            statusChangedAt: settled ? decidedAt : null,
            statusChangedByUserId: settled ? userId : null,
        });
    }
}

async function seedLearnRun(
    items: readonly DemoLearnItem[],
    scope: Scope,
    recordingId: string,
    transcription: { id: string; revision: number },
    turns: readonly TranscriptTurn[],
): Promise<void> {
    const userId = scope.userId;
    const [run] = await db
        .insert(learnRuns)
        .values({
            userId,
            scopeUserId: userId,
            itemId: recordingId,
            transcriptionId: transcription.id,
            view: "private",
            actorUserId: userId,
            trigger: "manual",
            transcriptRevision: transcription.revision,
            vocabularyVersion: 0,
            status: "ready",
        })
        .returning({ id: learnRuns.id });
    if (!run) throw new Error("Learn run was not created");

    const startOf = (index: number) => turns[index]?.startMs ?? 0;
    for (const [index, item] of items.entries()) {
        const row = reviewItem(item, scope, turns, startOf);
        await db.insert(learnReviewItems).values({
            runId: run.id,
            userId,
            kind: item.kind,
            fingerprintHmac: domainLookupHash(
                "learn-fingerprint",
                `${run.id}:${index}`,
            ),
            payload: encryptJsonField(row.payload),
            preTicked: row.preTicked,
        });
    }
}

function reviewItem(
    item: DemoLearnItem,
    scope: Scope,
    turns: readonly TranscriptTurn[],
    startOf: (index: number) => number,
): { payload: object; preTicked: boolean } {
    switch (item.kind) {
        case "speaker":
            return {
                preTicked: false,
                payload: {
                    label: item.label,
                    personId: personId(scope, item.person),
                    evidenceMs: item.atTurns.map(startOf),
                    reason: item.reason,
                },
            };
        case "new_record":
            return {
                preTicked: false,
                payload: {
                    ref: item.ref,
                    kind: item.recordKind,
                    typeKey: item.typeKey,
                    name: item.name,
                    evidenceMs: item.atTurns.map(startOf),
                    reason: item.reason,
                    ...(item.maybe
                        ? { maybe: { entityId: thingId(scope, item.maybe) } }
                        : {}),
                },
            };
        case "correction":
            return {
                preTicked: item.preTicked,
                payload: {
                    kind: "correct",
                    heard: item.heard,
                    target:
                        "person" in item.target
                            ? { personId: personId(scope, item.target.person) }
                            : { entityId: thingId(scope, item.target.thing) },
                    replacement: item.replacement,
                    anchors: anchorsOf(turns, item.heard),
                },
            };
        case "fact": {
            const turn = turns[item.atTurn];
            return {
                preTicked: item.preTicked,
                payload: {
                    subject:
                        "person" in item.subject
                            ? { personId: personId(scope, item.subject.person) }
                            : { entityId: thingId(scope, item.subject.thing) },
                    relationKey: item.relationKey,
                    object:
                        "newRef" in item.object
                            ? { newRef: item.object.newRef }
                            : "person" in item.object
                              ? {
                                    personId: personId(
                                        scope,
                                        item.object.person,
                                    ),
                                }
                              : { entityId: thingId(scope, item.object.thing) },
                    startMs: turn?.startMs ?? 0,
                    endMs: turn?.endMs ?? 0,
                    speakerLabel: turn?.speaker || null,
                },
            };
        }
    }
}
