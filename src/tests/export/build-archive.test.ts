import { Readable } from "node:stream";
import unzipper from "unzipper";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Schema from "@/db/schema";
import type { StorageProvider } from "@/lib/storage/types";

const { dbMock, archivedTasks } = vi.hoisted(() => ({
    dbMock: { select: vi.fn() },
    archivedTasks: new Map<string, unknown[]>(),
}));

vi.mock("@/db", () => ({ db: dbMock }));
vi.mock("@/lib/tasks/archive", () => ({
    tasksForArchive: vi.fn(async () => archivedTasks),
    taskUpdatesForArchive: vi.fn(async () => new Map()),
    archivedAssigneeIds: vi.fn(() => []),
}));
vi.mock("@/lib/mail/archive", () => ({
    collectArchivedMail: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/encryption", () => ({
    decryptBuffer: (value: Buffer) => value,
}));
vi.mock("@/db/schema", async (importOriginal) => ({
    // The recording reads select `audioItemColumns`, which is derived from
    // the real recording and item tables.
    recordings: (await importOriginal<typeof Schema>()).recordings,
    chatterItems: (await importOriginal<typeof Schema>()).chatterItems,
    users: { id: "users.id", role: "users.role" },
    learnRuns: {
        id: "learnRuns.id",
        scopeUserId: "learnRuns.scopeUserId",
        itemId: "learnRuns.itemId",
        transcriptionId: "learnRuns.transcriptionId",
        view: "learnRuns.view",
        trigger: "learnRuns.trigger",
        status: "learnRuns.status",
        path: "learnRuns.path",
        provider: "learnRuns.provider",
        model: "learnRuns.model",
        transcriptRevision: "learnRuns.transcriptRevision",
        stats: "learnRuns.stats",
        createdAt: "learnRuns.createdAt",
        finishedAt: "learnRuns.finishedAt",
    },
    learnReviewItems: {
        runId: "learnReviewItems.runId",
        kind: "learnReviewItems.kind",
        preTicked: "learnReviewItems.preTicked",
        decision: "learnReviewItems.decision",
        dependsOnLabel: "learnReviewItems.dependsOnLabel",
        payload: "learnReviewItems.payload",
    },
    transcriptions: "transcriptions",
    aiEnhancements: "aiEnhancements",
    aiUsageEvents: {
        __table: "aiUsageEvents",
        payerUserId: "aiUsageEvents.payerUserId",
    },
    apiCredentials: {
        __table: "apiCredentials",
        userId: "apiCredentials.userId",
        inputUsdPerMillion: "apiCredentials.inputUsdPerMillion",
        audioUsdPerHour: "apiCredentials.audioUsdPerHour",
    },
    // The knowledge-base reads project individual columns, so these
    // need a shape rather than a placeholder string.
    people: {
        id: "people.id",
        userId: "people.userId",
        displayName: "people.displayName",
        primaryEmail: "people.primaryEmail",
        notes: "people.notes",
        mergedIntoId: "people.mergedIntoId",
        createdAt: "people.createdAt",
    },
    transcriptSpeakers: {
        userId: "transcriptSpeakers.userId",
        transcriptionId: "transcriptSpeakers.transcriptionId",
        label: "transcriptSpeakers.label",
        personId: "transcriptSpeakers.personId",
        source: "transcriptSpeakers.source",
        status: "transcriptSpeakers.status",
        confidence: "transcriptSpeakers.confidence",
        evidenceStartMs: "transcriptSpeakers.evidenceStartMs",
        markedUnknown: "transcriptSpeakers.markedUnknown",
        confirmedByUserId: "transcriptSpeakers.confirmedByUserId",
    },
    transcriptSpeakerRejections: {
        userId: "transcriptSpeakerRejections.userId",
        transcriptionId: "transcriptSpeakerRejections.transcriptionId",
        label: "transcriptSpeakerRejections.label",
        personId: "transcriptSpeakerRejections.personId",
        createdAt: "transcriptSpeakerRejections.createdAt",
    },
    recordingFolders: {
        id: "recordingFolders.id",
        userId: "recordingFolders.userId",
        parentId: "recordingFolders.parentId",
        name: "recordingFolders.name",
        kind: "recordingFolders.kind",
        sortOrder: "recordingFolders.sortOrder",
        createdAt: "recordingFolders.createdAt",
    },
    recordingFolderAssignments: {
        userId: "recordingFolderAssignments.userId",
        itemId: "recordingFolderAssignments.itemId",
        folderId: "recordingFolderAssignments.folderId",
    },
    personNotes: {
        personId: "personNotes.personId",
        userId: "personNotes.userId",
        notes: "personNotes.notes",
    },
    personEmails: {
        __table: "personEmails",
        personId: "personEmails.personId",
        email: "personEmails.email",
    },
    transcriptCorrections: {
        userId: "transcriptCorrections.userId",
        transcriptionId: "transcriptCorrections.transcriptionId",
        transcriptRevision: "transcriptCorrections.transcriptRevision",
        turnIndex: "transcriptCorrections.turnIndex",
        charStart: "transcriptCorrections.charStart",
        charEnd: "transcriptCorrections.charEnd",
        heard: "transcriptCorrections.heard",
        kind: "transcriptCorrections.kind",
        targetPersonId: "transcriptCorrections.targetPersonId",
        targetEntityId: "transcriptCorrections.targetEntityId",
        replacement: "transcriptCorrections.replacement",
        preTicked: "transcriptCorrections.preTicked",
        createdAt: "transcriptCorrections.createdAt",
    },
    knowledgeEntities: {
        id: "knowledgeEntities.id",
        userId: "knowledgeEntities.userId",
        typeKey: "knowledgeEntities.typeKey",
        name: "knowledgeEntities.name",
        description: "knowledgeEntities.description",
        mergedIntoId: "knowledgeEntities.mergedIntoId",
        createdAt: "knowledgeEntities.createdAt",
    },
    knowledgeAliases: {
        userId: "knowledgeAliases.userId",
        personId: "knowledgeAliases.personId",
        entityId: "knowledgeAliases.entityId",
        kind: "knowledgeAliases.kind",
        text: "knowledgeAliases.text",
        language: "knowledgeAliases.language",
        provider: "knowledgeAliases.provider",
        createdAt: "knowledgeAliases.createdAt",
    },
    knowledgeFacts: {
        id: "knowledgeFacts.id",
        userId: "knowledgeFacts.userId",
        subjectPersonId: "knowledgeFacts.subjectPersonId",
        subjectEntityId: "knowledgeFacts.subjectEntityId",
        relationKey: "knowledgeFacts.relationKey",
        objectPersonId: "knowledgeFacts.objectPersonId",
        objectEntityId: "knowledgeFacts.objectEntityId",
        objectLiteral: "knowledgeFacts.objectLiteral",
        origin: "knowledgeFacts.origin",
        replacedByFactId: "knowledgeFacts.replacedByFactId",
        createdAt: "knowledgeFacts.createdAt",
    },
    knowledgeFactEvidence: {
        userId: "knowledgeFactEvidence.userId",
        factId: "knowledgeFactEvidence.factId",
        transcriptionId: "knowledgeFactEvidence.transcriptionId",
        itemId: "knowledgeFactEvidence.itemId",
        transcriptRevision: "knowledgeFactEvidence.transcriptRevision",
        startMs: "knowledgeFactEvidence.startMs",
        endMs: "knowledgeFactEvidence.endMs",
        speakerLabel: "knowledgeFactEvidence.speakerLabel",
        dependsOnSpeaker: "knowledgeFactEvidence.dependsOnSpeaker",
        quote: "knowledgeFactEvidence.quote",
        status: "knowledgeFactEvidence.status",
        confirmedAt: "knowledgeFactEvidence.confirmedAt",
    },
    knowledgeEntityNotes: {
        entityId: "knowledgeEntityNotes.entityId",
        userId: "knowledgeEntityNotes.userId",
        notes: "knowledgeEntityNotes.notes",
    },
    knowledgeEntityTypes: {
        userId: "knowledgeEntityTypes.userId",
        key: "knowledgeEntityTypes.key",
        label: "knowledgeEntityTypes.label",
        adoptedAsKey: "knowledgeEntityTypes.adoptedAsKey",
        createdAt: "knowledgeEntityTypes.createdAt",
    },
    knowledgeRelationTypes: {
        userId: "knowledgeRelationTypes.userId",
        key: "knowledgeRelationTypes.key",
        label: "knowledgeRelationTypes.label",
        subjectTypes: "knowledgeRelationTypes.subjectTypes",
        objectTypes: "knowledgeRelationTypes.objectTypes",
        objectKind: "knowledgeRelationTypes.objectKind",
        cardinality: "knowledgeRelationTypes.cardinality",
        adoptedAsKey: "knowledgeRelationTypes.adoptedAsKey",
        createdAt: "knowledgeRelationTypes.createdAt",
    },
    knowledgeVocabularyProposals: {
        id: "knowledgeVocabularyProposals.id",
        phrase: "knowledgeVocabularyProposals.phrase",
        status: "knowledgeVocabularyProposals.status",
    },
    knowledgeVocabularyProposalVotes: {
        proposalId: "knowledgeVocabularyProposalVotes.proposalId",
        userId: "knowledgeVocabularyProposalVotes.userId",
    },
}));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string | null) => (v == null ? v : `decrypted:${v}`),
    decryptJsonField: (v: unknown) => {
        if (Array.isArray(v)) return v.map((x) => `decrypted:${x}`);
        if (v && typeof v === "object" && "c" in v) {
            return JSON.parse((v as { c: string }).c);
        }
        return v;
    },
}));

type Row = Record<string, unknown>;

function mockSelectSequence(
    results: Row[][],
    extras: { usage?: Row[]; rates?: Row[] } = {},
) {
    let call = 0;
    dbMock.select.mockImplementation(() => ({
        from: (table: { __table?: string }) => {
            if (table?.__table === "aiUsageEvents") {
                return { where: () => Promise.resolve(extras.usage ?? []) };
            }
            if (table?.__table === "apiCredentials") {
                return { where: () => Promise.resolve(extras.rates ?? []) };
            }
            // Nobody here has an address beside their primary email.
            if (table?.__table === "personEmails") {
                return { where: () => Promise.resolve([]) };
            }
            // The folder assignment read joins its folder; the join itself
            // adds nothing a canned result needs to reproduce.
            const query = {
                innerJoin: () => query,
                where: () => Promise.resolve(results[call++] ?? []),
            };
            return query;
        },
    }));
}

import { buildAndUploadExportArchive } from "@/lib/export/build-archive";

/** In-memory StorageProvider that captures the uploaded archive bytes. */
class FakeStorage implements StorageProvider {
    uploaded: Buffer | null = null;
    files = new Map<string, Buffer>();
    /** Paths that `exists()` reports present but `downloadStream()` returns a `StuckReadable` for. */
    stuckPaths = new Set<string>();

    async uploadFile(key: string, buffer: Buffer): Promise<string> {
        this.files.set(key, buffer);
        return key;
    }
    async downloadFile(key: string): Promise<Buffer> {
        const buf = this.files.get(key);
        if (!buf) throw new Error("not found");
        return buf;
    }
    async downloadStream(key: string): Promise<Readable> {
        if (this.stuckPaths.has(key)) return new StuckReadable();
        const buf = this.files.get(key);
        if (!buf) throw new Error(`not found: ${key}`);
        return Readable.from(buf);
    }
    async uploadStream(
        key: string,
        stream: Readable,
        _contentType: string,
    ): Promise<string> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        this.uploaded = Buffer.concat(chunks);
        return key;
    }
    async exists(key: string): Promise<boolean> {
        return this.files.has(key) || this.stuckPaths.has(key);
    }
    async getSignedUrl(): Promise<string> {
        return "https://example.com/signed";
    }
    async deleteFile(key: string): Promise<void> {
        this.files.delete(key);
    }
    async testConnection(): Promise<boolean> {
        return true;
    }
}

/** Starts reading the archive only after a delay, as LocalStorage does after its directory checks. */
class LateStorage extends FakeStorage {
    override async uploadStream(
        key: string,
        stream: Readable,
        contentType: string,
    ): Promise<string> {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return super.uploadStream(key, stream, contentType);
    }
}

/**
 * A stream that never produces data and, crucially, never finishes
 * being destroyed -- `_destroy` deliberately never calls its callback.
 * Simulates archiver having stopped draining a source stream without
 * formally ending it: nothing about this stream will ever emit
 * `end`/`close`/`error` on its own. Used to prove that aborting
 * `buildAndUploadExportArchive` rejects via the abort-signal race
 * itself, not as a side effect of stream teardown completing.
 */
class StuckReadable extends Readable {
    _read(): void {
        // Never pushes data, never calls this.push(null).
    }
    _destroy(
        _err: Error | null,
        _callback: (error?: Error | null) => void,
    ): void {
        // Deliberately never calls `_callback`.
    }
}

interface ZipEntry {
    buffer: Buffer;
    /** 0 = stored (no compression), 8 = deflate. */
    compressionMethod: number;
}

async function readZipEntries(buffer: Buffer): Promise<Map<string, ZipEntry>> {
    const entries = new Map<string, ZipEntry>();
    const directory = await unzipper.Open.buffer(buffer);
    for (const file of directory.files) {
        entries.set(file.path, {
            buffer: await file.buffer(),
            compressionMethod: file.compressionMethod,
        });
    }
    return entries;
}

describe("buildAndUploadExportArchive", () => {
    let storage: FakeStorage;

    beforeEach(() => {
        vi.clearAllMocks();
        storage = new FakeStorage();
    });

    it("exports the payer's usage and rate snapshots", async () => {
        const date = new Date("2026-01-01T00:00:00Z");
        mockSelectSequence(
            [
                [
                    {
                        id: "rec-1",
                        userId: "user-1",
                        title: "enc-recording",
                        occurredAt: date,
                        endTime: date,
                        duration: 1000,
                        filesize: 0,
                        deviceSn: "SN1",
                        storagePath: "audio/missing.mp3",
                    },
                ],
                [],
                [],
            ],
            {
                usage: [
                    {
                        id: "usage-1",
                        itemId: "rec-1",
                        payerUserId: "user-1",
                        operation: "transcription",
                        costUsd: "0.006000000",
                        createdAt: date,
                    },
                ],
                rates: [
                    {
                        provider: "Custom",
                        model: "model-1",
                        baseUrl: "https://stt.example.com/v1",
                        inputUsdPerMillion: null,
                        outputUsdPerMillion: null,
                        audioUsdPerHour: "1.000000",
                    },
                ],
            },
        );

        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/usage.zip",
        });

        const entries = await readZipEntries(storage.uploaded as Buffer);
        const usage = [...entries.entries()].find(([name]) =>
            name.endsWith("/ai-usage.json"),
        );
        expect(JSON.parse(usage?.[1].buffer.toString("utf-8") ?? "[]")).toEqual(
            [
                expect.objectContaining({
                    id: "usage-1",
                    costUsd: "0.006000000",
                    createdAt: date.toISOString(),
                }),
            ],
        );
        const rates = JSON.parse(
            entries.get("ai/provider-rates.json")?.buffer.toString("utf-8") ??
                "[]",
        );
        expect(rates).toEqual([
            expect.objectContaining({
                provider: "Custom",
                model: "model-1",
                audioUsdPerHour: "1.000000",
            }),
        ]);
    });

    it("carries the knowledge base so a restore keeps who was speaking", async () => {
        // With no recordings, the transcript and enhancement reads are
        // skipped entirely, so the knowledge reads follow immediately.
        mockSelectSequence([
            // recordings
            [],
            // people
            [
                {
                    id: "p-1",
                    displayName: "enc-Jan",
                    primaryEmail: "enc-jan@fg.cz",
                    notes: null,
                    mergedIntoId: null,
                    createdAt: new Date("2026-01-01T00:00:00Z"),
                },
            ],
            // transcript speakers
            [
                {
                    transcriptionId: "tr-1",
                    label: "speaker_0",
                    personId: "p-1",
                    source: "user",
                    status: "confirmed",
                    confidence: null,
                    evidenceStartMs: 14_320,
                    markedUnknown: false,
                    confirmedByUserId: "user-1",
                },
                {
                    transcriptionId: "tr-1",
                    label: "speaker_1",
                    personId: null,
                    source: "user",
                    status: "confirmed",
                    confidence: null,
                    evidenceStartMs: null,
                    markedUnknown: true,
                    confirmedByUserId: "user-1",
                },
            ],
            // rejected suggestions
            [
                {
                    transcriptionId: "tr-1",
                    label: "speaker_1",
                    personId: "p-1",
                    createdAt: new Date("2026-01-02T00:00:00Z"),
                },
            ],
        ]);

        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/job-1.zip",
        });

        const entries = await readZipEntries(storage.uploaded as Buffer);
        const knowledge = JSON.parse(
            entries.get("knowledge/people.json")?.buffer.toString("utf-8") ??
                "{}",
        );

        expect(knowledge.people).toHaveLength(1);
        expect(knowledge.people[0].displayName).toBe("decrypted:enc-Jan");
        expect(knowledge.people[0].primaryEmail).toBe(
            "decrypted:enc-jan@fg.cz",
        );
        // The email hash is derived from a server secret, so it is recomputed
        // on restore rather than pinning the archive to one instance.
        expect(knowledge.people[0].primaryEmailHash).toBeUndefined();
        expect(knowledge.attributions).toEqual([
            {
                transcriptionId: "tr-1",
                label: "speaker_0",
                personId: "p-1",
                source: "user",
                status: "confirmed",
                confidence: null,
                evidenceStartMs: 14_320,
                markedUnknown: false,
                confirmedByUserId: "user-1",
            },
            {
                transcriptionId: "tr-1",
                label: "speaker_1",
                personId: null,
                source: "user",
                status: "confirmed",
                confidence: null,
                evidenceStartMs: null,
                markedUnknown: true,
                confirmedByUserId: "user-1",
            },
        ]);
        expect(knowledge.rejections).toEqual([
            {
                transcriptionId: "tr-1",
                label: "speaker_1",
                personId: "p-1",
                createdAt: "2026-01-02T00:00:00.000Z",
            },
        ]);

        const manifest = JSON.parse(
            entries.get("manifest.json")?.buffer.toString("utf-8") ?? "{}",
        );
        expect(manifest.knowledge).toEqual({
            people: 1,
            attributions: 2,
            rejections: 1,
            corrections: 0,
        });
    });

    it("carries corrections, and the Organization people they target", async () => {
        mockSelectSequence([
            // recordings, people, speakers, rejected suggestions
            [],
            [],
            [],
            [],
            // corrections
            [
                {
                    transcriptionId: "tr-1",
                    transcriptRevision: 3,
                    turnIndex: 0,
                    charStart: 16,
                    charEnd: 21,
                    heard: "enc-Novák",
                    kind: "correct",
                    personId: "p-org",
                    targetEntityId: null,
                    replacement: "enc-Novotný",
                    preTicked: false,
                    createdAt: new Date("2026-01-03T00:00:00Z"),
                },
            ],
            // the Organization people referenced
            [
                {
                    id: "p-org",
                    displayName: "enc-Jan Novotný",
                    primaryEmail: null,
                    notes: null,
                    mergedIntoId: null,
                    createdAt: new Date("2026-01-01T00:00:00Z"),
                },
            ],
            // the user's own notes on them
            [],
        ]);

        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/corrections.zip",
        });

        const entries = await readZipEntries(storage.uploaded as Buffer);
        const knowledge = JSON.parse(
            entries.get("knowledge/people.json")?.buffer.toString("utf-8") ??
                "{}",
        );
        expect(knowledge.corrections).toEqual([
            {
                transcriptionId: "tr-1",
                transcriptRevision: 3,
                turnIndex: 0,
                charStart: 16,
                charEnd: 21,
                heard: "decrypted:enc-Novák",
                kind: "correct",
                targetPersonId: "p-org",
                targetEntityId: null,
                replacement: "decrypted:enc-Novotný",
                preTicked: false,
                createdAt: "2026-01-03T00:00:00.000Z",
            },
        ]);
        expect(knowledge.people).toEqual([
            expect.objectContaining({
                id: "p-org",
                displayName: "decrypted:enc-Jan Novotný",
            }),
        ]);
        const manifest = JSON.parse(
            entries.get("manifest.json")?.buffer.toString("utf-8") ?? "{}",
        );
        expect(manifest.knowledge).toMatchObject({ corrections: 1, people: 1 });
    });

    it("carries folder organization and recording assignments", async () => {
        mockSelectSequence([
            [
                {
                    id: "rec-1",
                    userId: "user-1",
                    title: "enc-recording",
                    occurredAt: new Date("2026-01-03T00:00:00Z"),
                    endTime: new Date("2026-01-03T00:01:00Z"),
                    duration: 60_000,
                    filesize: 0,
                    deviceSn: "SN1",
                    storagePath: "audio/missing.mp3",
                },
            ],
            [],
            [],
            [],
            [],
            // rejected suggestions
            [],
            // corrections
            [],
            [
                {
                    id: "folder-private",
                    parentId: null,
                    name: "enc-Private",
                    kind: "private",
                    sortOrder: 0,
                    createdAt: new Date("2026-01-01T00:00:00Z"),
                },
                {
                    id: "folder-meetings",
                    parentId: "folder-private",
                    name: "enc-Meetings",
                    kind: "custom",
                    sortOrder: 2000,
                    createdAt: new Date("2026-01-02T00:00:00Z"),
                },
            ],
            [
                {
                    recordingId: "rec-1",
                    folderId: "folder-meetings",
                },
            ],
        ]);

        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/folders.zip",
        });

        const entries = await readZipEntries(storage.uploaded as Buffer);
        const organization = JSON.parse(
            entries
                .get("organization/folders.json")
                ?.buffer.toString("utf-8") ?? "{}",
        );
        expect(organization.folders).toHaveLength(2);
        expect(organization.folders[1].name).toBe("decrypted:enc-Meetings");
        expect(organization.folders[1].sortOrder).toBe(2000);
        expect(organization.assignments).toEqual([
            { recordingId: "rec-1", folderId: "folder-meetings" },
        ]);

        const manifest = JSON.parse(
            entries.get("manifest.json")?.buffer.toString("utf-8") ?? "{}",
        );
        expect(manifest.organization).toEqual({ folders: 2, assignments: 1 });
    });

    it("carries the user's own vocabulary and the phrases they suggested", async () => {
        mockSelectSequence([
            // recordings, people, attributions, rejected suggestions,
            // corrections, folders, assignments
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            [
                {
                    key: "u_type1",
                    label: "enc-Supplier",
                    adoptedAsKey: null,
                    createdAt: new Date("2026-01-04T00:00:00Z"),
                },
            ],
            [
                {
                    key: "u_rel1",
                    label: "enc-mentors",
                    subjectTypes: ["person"],
                    objectTypes: ["person"],
                    objectKind: "entity",
                    cardinality: "many",
                    adoptedAsKey: "o_rel1",
                    createdAt: new Date("2026-01-05T00:00:00Z"),
                },
            ],
            [{ phrase: "enc-mentors", status: "adopted" }],
        ]);

        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/vocabulary.zip",
        });

        const entries = await readZipEntries(storage.uploaded as Buffer);
        const vocabulary = JSON.parse(
            entries
                .get("knowledge/vocabulary.json")
                ?.buffer.toString("utf-8") ?? "{}",
        );
        expect(vocabulary.entityTypes).toEqual([
            {
                key: "u_type1",
                label: "decrypted:enc-Supplier",
                adoptedAsKey: null,
                createdAt: "2026-01-04T00:00:00.000Z",
            },
        ]);
        expect(vocabulary.relationTypes[0]).toMatchObject({
            key: "u_rel1",
            label: "decrypted:enc-mentors",
            objectTypes: ["person"],
            adoptedAsKey: "o_rel1",
        });
        expect(vocabulary.suggestedPhrases).toEqual([
            { phrase: "decrypted:enc-mentors", status: "adopted" },
        ]);
        const manifest = JSON.parse(
            entries.get("manifest.json")?.buffer.toString("utf-8") ?? "{}",
        );
        expect(manifest.vocabulary).toEqual({
            entityTypes: 1,
            relationTypes: 1,
            suggestedPhrases: 1,
        });
    });

    it("carries entities, the names given them, and the Organization's they point at", async () => {
        mockSelectSequence([
            // recordings, people, speakers, rejected suggestions,
            // corrections, folders, assignments, entity types, relation
            // types, suggested phrases
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            // own entities
            [
                {
                    id: "e-own",
                    typeKey: "project",
                    name: "enc-Orion",
                    description: "enc-CRM migration",
                    mergedIntoId: null,
                    createdAt: new Date("2026-01-01T00:00:00Z"),
                },
            ],
            // aliases
            [
                {
                    personId: null,
                    entityId: "e-org",
                    kind: "heard_as",
                    text: "enc-Senezi",
                    language: "cs",
                    provider: "openai",
                    createdAt: new Date("2026-01-02T00:00:00Z"),
                },
                {
                    personId: "p-org",
                    entityId: null,
                    kind: "alias",
                    text: "enc-Honza",
                    language: null,
                    provider: null,
                    createdAt: new Date("2026-01-03T00:00:00Z"),
                },
            ],
            // notes on Organization entities
            [{ entityId: "e-org", notes: "enc-our biggest client" }],
            // entities the corrections target
            [],
            // the Organization entities referenced
            [
                {
                    id: "e-org",
                    typeKey: "organization",
                    name: "enc-Tavesi",
                    description: null,
                    mergedIntoId: null,
                    createdAt: new Date("2026-01-01T00:00:00Z"),
                },
            ],
            // the Organization people the aliases name
            [
                {
                    id: "p-org",
                    displayName: "enc-Jan Novotný",
                    mergedIntoId: null,
                },
            ],
        ]);

        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/entities.zip",
        });

        const entries = await readZipEntries(storage.uploaded as Buffer);
        const archived = JSON.parse(
            entries.get("knowledge/entities.json")?.buffer.toString("utf-8") ??
                "{}",
        );
        expect(archived.entities).toEqual([
            expect.objectContaining({
                id: "e-own",
                name: "decrypted:enc-Orion",
                description: "decrypted:enc-CRM migration",
                organization: false,
            }),
            expect.objectContaining({
                id: "e-org",
                name: "decrypted:enc-Tavesi",
                organization: true,
            }),
        ]);
        expect(archived.aliases.map((a: { text: string }) => a.text)).toEqual([
            "decrypted:enc-Senezi",
            "decrypted:enc-Honza",
        ]);
        expect(archived.notes).toEqual([
            { entityId: "e-org", notes: "decrypted:enc-our biggest client" },
        ]);
        expect(archived.people).toEqual([
            {
                id: "p-org",
                displayName: "decrypted:enc-Jan Novotný",
                mergedIntoId: null,
            },
        ]);
        const manifest = JSON.parse(
            entries.get("manifest.json")?.buffer.toString("utf-8") ?? "{}",
        );
        expect(manifest.entities).toEqual({
            entities: 2,
            aliases: 2,
            notes: 1,
        });
    });

    it("carries facts, where they were said, and the Organization's people they name", async () => {
        mockSelectSequence([
            // recordings, people, speakers, rejected suggestions,
            // corrections, folders, assignments, entity types, relation
            // types, suggested phrases, entities, aliases, entity notes,
            // correction targets
            ...Array.from({ length: 14 }, () => []),
            // facts
            [
                {
                    id: "f-1",
                    subjectPersonId: "p-org",
                    subjectEntityId: null,
                    relationKey: "has_role",
                    objectPersonId: null,
                    objectEntityId: null,
                    objectLiteral: "enc-CTO",
                    origin: "recording",
                    replacedByFactId: null,
                    createdAt: new Date("2026-03-03T00:00:00Z"),
                },
            ],
            // evidence
            [
                {
                    factId: "f-1",
                    transcriptionId: "tr-1",
                    recordingId: "rec-1",
                    transcriptRevision: 2,
                    startMs: 724_000,
                    endMs: 739_000,
                    speakerLabel: "speaker_1",
                    dependsOnSpeaker: true,
                    quote: "enc-I am the CTO",
                    status: "supported",
                    confirmedAt: new Date("2026-03-04T00:00:00Z"),
                },
            ],
            // the Organization people named
            [{ id: "p-org", displayName: "enc-Jan", mergedIntoId: null }],
        ]);

        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/facts.zip",
        });

        const entries = await readZipEntries(storage.uploaded as Buffer);
        const archived = JSON.parse(
            entries.get("knowledge/facts.json")?.buffer.toString("utf-8") ??
                "{}",
        );
        expect(archived.facts).toEqual([
            expect.objectContaining({
                id: "f-1",
                relationKey: "has_role",
                objectLiteral: "decrypted:enc-CTO",
            }),
        ]);
        expect(archived.evidence).toEqual([
            expect.objectContaining({
                factId: "f-1",
                quote: "decrypted:enc-I am the CTO",
                dependsOnSpeaker: true,
            }),
        ]);
        expect(archived.people).toEqual([
            {
                id: "p-org",
                displayName: "decrypted:enc-Jan",
                mergedIntoId: null,
            },
        ]);
        const manifest = JSON.parse(
            entries.get("manifest.json")?.buffer.toString("utf-8") ?? "{}",
        );
        expect(manifest.facts).toEqual({ facts: 1, evidence: 1 });
    });

    it("carries the transcription ids the attributions are keyed on", async () => {
        storage.files.set("audio/rec-1.mp3", Buffer.from("audio"));
        mockSelectSequence([
            [
                {
                    id: "rec-1",
                    userId: "user-1",
                    title: "enc-filename",
                    occurredAt: new Date("2026-01-01T00:00:00Z"),
                    endTime: new Date("2026-01-01T00:01:00Z"),
                    duration: 60000,
                    filesize: 5,
                    deviceSn: "SN123",
                    storagePath: "audio/rec-1.mp3",
                },
            ],
            [
                {
                    id: "tr-1",
                    recordingId: "rec-1",
                    source: "riffado",
                    text: "enc-transcript",
                    turns: {
                        c: JSON.stringify([
                            {
                                speaker: "speaker_0",
                                startMs: 0,
                                endMs: 1000,
                                text: "Ahoj.",
                            },
                        ]),
                    },
                    createdAt: new Date("2026-01-01T00:02:00Z"),
                },
            ],
            [],
            [
                {
                    id: "p-1",
                    displayName: "enc-Jan",
                    primaryEmail: null,
                    notes: null,
                    mergedIntoId: null,
                    createdAt: new Date("2026-01-01T00:00:00Z"),
                },
            ],
            [
                {
                    transcriptionId: "tr-1",
                    label: "speaker_0",
                    personId: "p-1",
                    source: "user",
                    status: "confirmed",
                    confidence: null,
                    evidenceStartMs: null,
                },
            ],
        ]);

        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/job-1.zip",
        });

        const entries = await readZipEntries(storage.uploaded as Buffer);
        const outsideKnowledge = [...entries.entries()]
            .filter(([name]) => name !== "knowledge/people.json")
            .map(([, entry]) => entry.buffer.toString("utf-8"))
            .join("\n");

        expect(outsideKnowledge.includes("tr-1")).toBe(true);
    });

    it("carries the turns an attribution is projected onto", async () => {
        storage.files.set("audio/rec-1.mp3", Buffer.from("audio"));
        mockSelectSequence([
            [
                {
                    id: "rec-1",
                    userId: "user-1",
                    title: "enc-filename",
                    occurredAt: new Date("2026-01-01T00:00:00Z"),
                    endTime: new Date("2026-01-01T00:01:00Z"),
                    duration: 60000,
                    filesize: 5,
                    deviceSn: "SN123",
                    storagePath: "audio/rec-1.mp3",
                },
            ],
            [
                {
                    id: "tr-1",
                    recordingId: "rec-1",
                    source: "riffado",
                    text: "enc-transcript",
                    turns: {
                        c: JSON.stringify([
                            {
                                speaker: "speaker_0",
                                startMs: 0,
                                endMs: 1000,
                                text: "Ahoj.",
                            },
                        ]),
                    },
                    createdAt: new Date("2026-01-01T00:02:00Z"),
                },
            ],
            [],
            [],
            [],
        ]);

        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/job-1.zip",
        });

        const entries = await readZipEntries(storage.uploaded as Buffer);
        const transcripts = [...entries.entries()].find(([name]) =>
            name.endsWith("/transcripts.json"),
        );

        expect(transcripts).toBeDefined();
        const record = JSON.parse(
            (transcripts as [string, { buffer: Buffer }])[1].buffer.toString(
                "utf-8",
            ),
        );
        expect(record[0].id).toBe("tr-1");
        expect(record[0].turns).not.toBeNull();
    });

    it("keeps both transcripts when a recording has two", async () => {
        storage.files.set("audio/rec-1.mp3", Buffer.from("audio"));
        mockSelectSequence([
            [
                {
                    id: "rec-1",
                    userId: "user-1",
                    title: "enc-filename",
                    occurredAt: new Date("2026-01-01T00:00:00Z"),
                    endTime: new Date("2026-01-01T00:01:00Z"),
                    duration: 60000,
                    filesize: 5,
                    deviceSn: "SN123",
                    storagePath: "audio/rec-1.mp3",
                },
            ],
            [
                {
                    id: "tr-plaud",
                    recordingId: "rec-1",
                    source: "plaud",
                    text: "enc-plaud",
                    createdAt: new Date("2026-01-01T00:02:00Z"),
                },
                {
                    id: "tr-riffado",
                    recordingId: "rec-1",
                    source: "riffado",
                    text: "enc-riffado",
                    createdAt: new Date("2026-01-01T00:03:00Z"),
                },
            ],
            [],
            [],
            [],
        ]);

        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/job-1.zip",
        });

        const entries = await readZipEntries(storage.uploaded as Buffer);
        const transcripts = [...entries.entries()].find(([name]) =>
            name.endsWith("/transcripts.json"),
        );
        const record = JSON.parse(
            (transcripts as [string, { buffer: Buffer }])[1].buffer.toString(
                "utf-8",
            ),
        );

        expect(record).toHaveLength(2);
        expect(record.map((t: { id: string }) => t.id)).toEqual([
            "tr-plaud",
            "tr-riffado",
        ]);
    });

    it("keeps the raw speaker labels in the archived transcript", async () => {
        storage.files.set("audio/rec-1.mp3", Buffer.from("audio"));
        mockSelectSequence([
            [
                {
                    id: "rec-1",
                    userId: "user-1",
                    title: "enc-filename",
                    occurredAt: new Date("2026-01-01T00:00:00Z"),
                    endTime: new Date("2026-01-01T00:01:00Z"),
                    duration: 60000,
                    filesize: 5,
                    deviceSn: "SN123",
                    storagePath: "audio/rec-1.mp3",
                },
            ],
            [
                {
                    id: "tr-1",
                    recordingId: "rec-1",
                    source: "riffado",
                    text: "speaker_0: Ahoj.",
                    createdAt: new Date("2026-01-01T00:02:00Z"),
                },
            ],
            [],
            [],
            [],
        ]);

        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/job-1.zip",
        });

        const entries = await readZipEntries(storage.uploaded as Buffer);
        const transcript = [...entries.entries()].find(([name]) =>
            name.endsWith("/transcript.txt"),
        );

        // The archive is the restorable copy, so it stores what the database
        // stores and leaves the overlay to `knowledge/people.json`. The JSON
        // export and the document sidecars project names instead; the three
        // must not silently converge on different answers.
        expect(transcript?.[1].buffer.toString("utf-8")).toBe(
            "decrypted:speaker_0: Ahoj.",
        );
    });

    it("keeps every tombstone's winner inside the same archive", async () => {
        mockSelectSequence([
            [],
            [
                {
                    id: "p-loser",
                    displayName: "enc-Alice",
                    primaryEmail: null,
                    notes: null,
                    mergedIntoId: "p-keep",
                    createdAt: new Date("2026-01-01T00:00:00Z"),
                },
                {
                    id: "p-keep",
                    displayName: "enc-Bob",
                    primaryEmail: null,
                    notes: null,
                    mergedIntoId: null,
                    createdAt: new Date("2026-01-01T00:00:00Z"),
                },
            ],
            [],
        ]);

        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/job-1.zip",
        });

        const entries = await readZipEntries(storage.uploaded as Buffer);
        const knowledge = JSON.parse(
            entries.get("knowledge/people.json")?.buffer.toString("utf-8") ??
                "{}",
        );
        const ids = new Set(
            (knowledge.people as { id: string }[]).map((person) => person.id),
        );
        for (const person of knowledge.people as {
            mergedIntoId: string | null;
        }[]) {
            if (person.mergedIntoId) {
                expect(ids.has(person.mergedIntoId)).toBe(true);
            }
        }
    });

    it("omits the knowledge section entirely when there is none", async () => {
        mockSelectSequence([[], [], []]);

        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/job-1.zip",
        });

        const entries = await readZipEntries(storage.uploaded as Buffer);
        expect([...entries.keys()]).not.toContain("knowledge/people.json");
        expect([...entries.keys()]).not.toContain("knowledge/vocabulary.json");
        expect([...entries.keys()]).not.toContain("knowledge/entities.json");
        expect([...entries.keys()]).not.toContain("knowledge/facts.json");
        const manifest = JSON.parse(
            entries.get("manifest.json")?.buffer.toString("utf-8") ?? "{}",
        );
        expect(manifest.knowledge).toBeUndefined();
    });

    it("bundles audio, transcript, and summary per recording plus a manifest", async () => {
        storage.files.set("audio/rec-1.mp3", Buffer.from("fake-audio-bytes-1"));

        mockSelectSequence([
            [
                {
                    id: "rec-1",
                    userId: "user-1",
                    title: "enc-filename",
                    occurredAt: new Date("2026-01-01T00:00:00Z"),
                    endTime: new Date("2026-01-01T00:01:00Z"),
                    duration: 60000,
                    filesize: 18,
                    deviceSn: "SN123",
                    storagePath: "audio/rec-1.mp3",
                },
            ],
            [
                {
                    id: "tr-1",
                    recordingId: "rec-1",
                    source: "riffado",
                    text: "enc-transcript",
                    createdAt: new Date("2026-01-01T00:02:00Z"),
                },
            ],
            [
                {
                    itemId: "rec-1",
                    summary: "A concise summary",
                    actionItems: ["do a thing"],
                    keyPoints: ["key point"],
                    provider: "openai",
                    model: "gpt-4o",
                    createdAt: new Date("2026-01-01T00:02:00Z"),
                },
            ],
        ]);

        const result = await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/job-1.zip",
        });

        expect(result.recordingCount).toBe(1);
        expect(result.fileSize).toBeGreaterThan(0);
        expect(storage.uploaded).not.toBeNull();

        const entries = await readZipEntries(storage.uploaded as Buffer);
        const names = [...entries.keys()];
        expect(names).toContain("manifest.json");
        expect(names.some((n) => n.endsWith("/audio.mp3"))).toBe(true);
        expect(names.some((n) => n.endsWith("/transcript.txt"))).toBe(true);
        expect(names.some((n) => n.endsWith("/summary.json"))).toBe(true);

        const manifest = JSON.parse(
            entries.get("manifest.json")?.buffer.toString("utf-8") ?? "{}",
        );
        expect(manifest.recordings).toHaveLength(1);
        expect(manifest.recordings[0].audio.included).toBe(true);
        expect(manifest.recordings[0].transcript.included).toBe(true);
        expect(manifest.recordings[0].summary.included).toBe(true);
        expect(manifest.recordings[0].filename).toBe("decrypted:enc-filename");

        const transcriptEntry = [...entries.entries()].find(([n]) =>
            n.endsWith("/transcript.txt"),
        );
        expect(transcriptEntry?.[1].buffer.toString("utf-8")).toBe(
            "decrypted:enc-transcript",
        );

        // Regression: the summary must go through decryptText/
        // decryptJsonField before landing in the archive, same as the
        // transcript -- otherwise the "summary.json" entry would contain
        // ciphertext instead of the user's readable summary.
        const summaryEntry = [...entries.entries()].find(([n]) =>
            n.endsWith("/summary.json"),
        );
        const summaryJson = JSON.parse(
            summaryEntry?.[1].buffer.toString("utf-8") ?? "{}",
        );
        expect(summaryJson.summary).toBe("decrypted:A concise summary");
        expect(summaryJson.actionItems).toEqual(["decrypted:do a thing"]);
        expect(summaryJson.keyPoints).toEqual(["decrypted:key point"]);

        // Audio is already-compressed media -- deflating it again wastes
        // CPU for no size benefit, so it should be stored (method 0), not
        // deflated (method 8). The small text entries are worth deflating.
        const audioEntry = [...entries.entries()].find(([n]) =>
            n.endsWith("/audio.mp3"),
        );
        expect(audioEntry?.[1].compressionMethod).toBe(0);
        expect(entries.get("manifest.json")?.compressionMethod).toBe(8);
    });

    it("carries a recording's accepted tasks", async () => {
        archivedTasks.set("rec-1", [
            { id: "task-1", status: "done", text: "Draft the pricing page" },
        ]);
        mockSelectSequence([
            [
                {
                    id: "rec-1",
                    userId: "user-1",
                    title: "enc-filename",
                    occurredAt: new Date("2026-01-01T00:00:00Z"),
                    endTime: new Date("2026-01-01T00:01:00Z"),
                    duration: 60000,
                    filesize: 18,
                    deviceSn: "SN123",
                    storagePath: "audio/missing.mp3",
                },
            ],
            [],
            [],
        ]);
        try {
            await buildAndUploadExportArchive({
                scope: { kind: "personal", userId: "user-1" },
                sourceStorage: storage,
                destinationStorage: storage,
                storageKey: "exports/user-1/job-tasks.zip",
            });
        } finally {
            archivedTasks.clear();
        }
        const entries = await readZipEntries(storage.uploaded as Buffer);
        const tasksEntry = [...entries.entries()].find(([name]) =>
            name.endsWith("/tasks.json"),
        );
        expect(
            JSON.parse(tasksEntry?.[1].buffer.toString("utf-8") ?? "[]"),
        ).toEqual([
            { id: "task-1", status: "done", text: "Draft the pricing page" },
        ]);
        const manifest = JSON.parse(
            entries.get("manifest.json")?.buffer.toString("utf-8") ?? "{}",
        );
        expect(manifest.recordings[0].tasks).toMatchObject({
            included: true,
            count: 1,
        });
    });

    it("records the size of what was stored when the storage starts reading late", async () => {
        // LocalStorage checks its directory before it pipes the archive to
        // disk: whatever flowed before that was counted but never written,
        // so the download's Content-Length promised bytes the file lacked.
        const late = new LateStorage();
        late.files.set("audio/rec-1.mp3", Buffer.alloc(256 * 1024, 7));
        mockSelectSequence([
            [
                {
                    id: "rec-1",
                    userId: "user-1",
                    title: "enc-filename",
                    occurredAt: new Date("2026-01-01T00:00:00Z"),
                    endTime: new Date("2026-01-01T00:01:00Z"),
                    duration: 60000,
                    filesize: 256 * 1024,
                    deviceSn: "SN123",
                    storagePath: "audio/rec-1.mp3",
                },
            ],
            [],
            [],
        ]);

        const result = await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: late,
            destinationStorage: late,
            storageKey: "exports/user-1/job-late.zip",
        });

        expect(late.uploaded?.length).toBe(result.fileSize);
        const entries = await readZipEntries(late.uploaded as Buffer);
        const audio = [...entries.entries()].find(([n]) =>
            n.endsWith("/audio.mp3"),
        );
        expect(audio?.[1].buffer.length).toBe(256 * 1024);
    });

    it("skips missing audio without failing the whole export, and notes why in the manifest", async () => {
        // No file registered at this storagePath -- exists() returns false.
        mockSelectSequence([
            [
                {
                    id: "rec-missing",
                    userId: "user-1",
                    title: "enc-filename",
                    occurredAt: new Date("2026-01-01T00:00:00Z"),
                    endTime: new Date("2026-01-01T00:01:00Z"),
                    duration: 1000,
                    filesize: 0,
                    deviceSn: "SN1",
                    storagePath: "audio/does-not-exist.mp3",
                },
            ],
            [],
            [],
        ]);

        const result = await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/job-2.zip",
        });

        expect(result.recordingCount).toBe(1);
        const entries = await readZipEntries(storage.uploaded as Buffer);
        const manifest = JSON.parse(
            entries.get("manifest.json")?.buffer.toString("utf-8") ?? "{}",
        );
        expect(manifest.recordings[0].audio.included).toBe(false);
        expect(manifest.recordings[0].audio.reason).toBeTruthy();
        // No audio entry should have been written for this recording.
        expect([...entries.keys()].some((n) => n.includes("audio"))).toBe(
            false,
        );
    });

    it("aborts and rejects immediately when the signal is already aborted", async () => {
        mockSelectSequence([[], [], []]);
        const controller = new AbortController();
        controller.abort();

        await expect(
            buildAndUploadExportArchive({
                scope: { kind: "personal", userId: "user-1" },
                sourceStorage: storage,
                destinationStorage: storage,
                storageKey: "exports/user-1/job-3.zip",
                signal: controller.signal,
            }),
        ).rejects.toThrow();
    });

    it("produces an empty-but-valid archive (manifest only) for a user with no recordings", async () => {
        mockSelectSequence([[], [], []]);

        const result = await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/job-4.zip",
        });

        expect(result.recordingCount).toBe(0);
        const entries = await readZipEntries(storage.uploaded as Buffer);
        expect([...entries.keys()]).toEqual(["manifest.json"]);
    });

    it("rejects (rather than hanging forever) when aborted while waiting for a stuck audio stream to settle", async () => {
        // Regression: the pre-manifest `await` on every audio entry
        // settling was not raced against `signal`, so an abort while an
        // entry was still draining (or stuck) would hang the whole
        // function instead of rejecting -- silently defeating the
        // worker's stall/max-duration guard, which needs this promise to
        // actually settle to stop the job.
        storage.stuckPaths.add("audio/stuck.mp3");
        mockSelectSequence([
            [
                {
                    id: "rec-stuck",
                    userId: "user-1",
                    title: "enc-filename",
                    occurredAt: new Date("2026-01-01T00:00:00Z"),
                    endTime: new Date("2026-01-01T00:01:00Z"),
                    duration: 1000,
                    filesize: 100,
                    deviceSn: "SN1",
                    storagePath: "audio/stuck.mp3",
                },
            ],
            [],
            [],
        ]);

        const controller = new AbortController();
        const promise = buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "user-1" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/user-1/job-5.zip",
            signal: controller.signal,
        });
        // Let the build start and reach the audio-settled wait, then abort.
        setTimeout(() => controller.abort(), 20);

        await expect(promise).rejects.toThrow(/abort/i);
    }, 5000);
});
