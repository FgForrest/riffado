import { and, eq, isNull } from "drizzle-orm";
import {
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import type { McpCaller } from "@/lib/mcp/caller";
import type { McpRole } from "@/lib/mcp/roles";
import { insertRecordings } from "@/tests/integration/items";
import type { TestDatabase } from "@/tests/integration/postgres";

/** A user caller as `resolveCaller` builds one. */
export function userCaller(
    userId: string,
    email: string,
    roles: McpRole[],
    orgUserId: string | null,
): McpCaller {
    return {
        kind: "user",
        userId,
        email,
        subject: `${userId}-sub`,
        clientId: "test-client",
        roles: new Set(roles),
        orgUserId,
    };
}

/** A service caller acting as the Organization account. */
export function serviceCaller(orgUserId: string, roles: McpRole[]): McpCaller {
    return {
        kind: "service",
        subject: "service-sub",
        clientId: "test-bot",
        roles: new Set(roles),
        orgUserId,
    };
}

/** Insert a recording with an encrypted title. */
export async function insertRecording(
    db: TestDatabase,
    {
        id,
        userId,
        title = `Recording ${id}`,
        startTime = new Date("2026-09-01T10:00:00Z"),
        deletedAt = null,
    }: {
        id: string;
        userId: string;
        title?: string;
        startTime?: Date;
        deletedAt?: Date | null;
    },
): Promise<void> {
    await insertRecordings(db, {
        id,
        userId,
        deviceSn: "SN-1",
        plaudFileId: `plaud-${id}`,
        filename: encryptText(title),
        duration: 60_000,
        startTime,
        endTime: new Date(startTime.getTime() + 60_000),
        filesize: 1000,
        fileMd5: "0".repeat(32),
        storageType: "local",
        storagePath: `${userId}/${id}.mp3`,
        plaudVersion: "1",
        deletedAt,
    });
}

/** File a recording into the Organization root: it is shared from now. */
export async function shareRecording(
    db: TestDatabase,
    recordingId: string,
    orgUserId: string,
): Promise<void> {
    const [root] = await db
        .select({ id: recordingFolders.id })
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.userId, orgUserId),
                isNull(recordingFolders.parentId),
            ),
        )
        .limit(1);
    const [recording] = await db
        .select({ userId: recordings.userId })
        .from(recordings)
        .where(eq(recordings.id, recordingId));
    if (!root || !recording) throw new Error("cannot share");
    await db.insert(recordingFolderAssignments).values({
        userId: recording.userId,
        itemId: recordingId,
        folderId: root.id,
    });
}

/** Insert a transcript of a recording, owned by its owner. */
export async function insertTranscript(
    db: TestDatabase,
    recordingId: string,
    userId: string,
    { text = "Hello.", language = null as string | null } = {},
): Promise<string> {
    const [row] = await db
        .insert(transcriptions)
        .values({
            recordingId,
            userId,
            text: encryptText(text),
            detectedLanguage: language,
            provider: "openai",
            model: "whisper-1",
            source: "riffado",
        })
        .returning({ id: transcriptions.id });
    if (!row) throw new Error("transcript not inserted");
    return row.id;
}

/** Insert a person of `userId`'s Almanac (the org account's: the Organization's). */
export async function insertPerson(
    db: TestDatabase,
    userId: string,
    name: string,
    { emailHash = null as string | null } = {},
): Promise<string> {
    const [row] = await db
        .insert(people)
        .values({
            userId,
            displayName: encryptText(name),
            primaryEmailHash: emailHash,
        })
        .returning({ id: people.id });
    if (!row) throw new Error("person not inserted");
    return row.id;
}

/** Attribute a speaker of a transcript, as its owner did. */
export async function attributeSpeaker(
    db: TestDatabase,
    {
        userId,
        transcriptionId,
        label,
        personId,
        status = "confirmed",
    }: {
        userId: string;
        transcriptionId: string;
        label: string;
        personId: string;
        status?: "confirmed" | "suggested";
    },
): Promise<void> {
    await db.insert(transcriptSpeakers).values({
        userId,
        transcriptionId,
        label,
        personId,
        source: "user",
        status,
    });
}

/** Insert a task on a recording, owned by the recording's owner. */
export async function insertTask(
    db: TestDatabase,
    {
        recordingId,
        userId,
        assigneePersonId = null,
        status = "open",
        text = "Do the thing",
    }: {
        recordingId: string;
        userId: string;
        assigneePersonId?: string | null;
        status?: "proposed" | "open" | "done" | "dropped";
        text?: string;
    },
): Promise<string> {
    const [row] = await db
        .insert(recordingTasks)
        .values({
            itemId: recordingId,
            userId,
            status,
            text: encryptText(text),
            assigneePersonId,
            source: "manual",
        })
        .returning({ id: recordingTasks.id });
    if (!row) throw new Error("task not inserted");
    return row.id;
}
