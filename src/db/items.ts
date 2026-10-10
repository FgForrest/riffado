import { and, eq, getTableColumns } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { db } from "@/db";
import { chatterItems, recordings } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/** Join condition from a recording to its item (same id, same owner). */
export const recordingItemJoin = eq(chatterItems.id, recordings.id);

const {
    deprecatedFilename: _filename,
    deprecatedStartTime: _startTime,
    deprecatedTitleEditedAt: _titleEditedAt,
    deprecatedSummaryDueAt: _summaryDueAt,
    deprecatedTranscriptReapedAt: _transcriptReapedAt,
    deprecatedSummaryReapedAt: _summaryReapedAt,
    deprecatedUnsharedAt: _unsharedAt,
    ...recordingOwnColumns
} = getTableColumns(recordings);

/**
 * A recording's own columns with what its item holds, for a select over
 * `recordings` joined by `recordingItemJoin`.
 */
export const audioItemColumns = {
    ...recordingOwnColumns,
    title: chatterItems.title,
    titleEditedAt: chatterItems.titleEditedAt,
    occurredAt: chatterItems.occurredAt,
    summaryDueAt: chatterItems.summaryDueAt,
    contentReapedAt: chatterItems.contentReapedAt,
    summaryReapedAt: chatterItems.summaryReapedAt,
};

/** A row selected with `audioItemColumns`. */
export type AudioItemRow = {
    [K in keyof typeof audioItemColumns]: (typeof audioItemColumns)[K]["_"]["data"] extends infer D
        ? (typeof audioItemColumns)[K]["_"]["notNull"] extends true
            ? D
            : D | null
        : never;
};

/**
 * A recording row as API responses carried it before its title, start and
 * markers moved to the item: `filename`, `startTime`, `transcriptReapedAt`.
 */
export function toRecordingResponseRow<
    T extends {
        title: string;
        occurredAt: Date;
        contentReapedAt: Date | null;
    },
>({
    title,
    occurredAt,
    contentReapedAt,
    kind: _kind,
    ...rest
}: T & {
    kind?: string;
}) {
    return {
        ...rest,
        filename: title,
        startTime: occurredAt,
        transcriptReapedAt: contentReapedAt,
    };
}

/** A recording's columns that are its own, as an insert takes them. */
export type NewRecording = Omit<
    typeof recordings.$inferInsert,
    | "kind"
    | "deprecatedFilename"
    | "deprecatedStartTime"
    | "deprecatedTitleEditedAt"
    | "deprecatedSummaryDueAt"
    | "deprecatedTranscriptReapedAt"
    | "deprecatedSummaryReapedAt"
    | "deprecatedUnsharedAt"
>;

/** A new recording with what its item holds. */
export interface NewAudioItem extends NewRecording {
    /** Encrypted. */
    title: string;
    occurredAt: Date;
    titleEditedAt?: Date | null;
}

/**
 * Inserts a recording and its `audio` item, in one transaction (a
 * savepoint when `executor` already is one).
 */
export async function insertAudioItem(
    executor: Executor,
    values: NewAudioItem,
): Promise<{ id: string }> {
    const { title, occurredAt, titleEditedAt, ...recording } = values;
    const id = recording.id ?? nanoid();
    const createdAt = recording.createdAt ?? new Date();
    const updatedAt = recording.updatedAt ?? createdAt;
    const insert = async (tx: Tx) => {
        await tx.insert(chatterItems).values({
            id,
            userId: recording.userId,
            kind: "audio",
            title,
            titleEditedAt: titleEditedAt ?? null,
            occurredAt,
            deletedAt: recording.deletedAt ?? null,
            createdAt,
            updatedAt,
        });
        await tx
            .insert(recordings)
            .values({ ...recording, id, createdAt, updatedAt });
        return { id };
    };
    return (executor as typeof db).transaction(insert);
}

/**
 * Tombstones a recording and its item at `at`, releasing any Learn hold.
 * Scoped to the owner.
 */
export async function markRecordingDeleted(
    executor: Executor,
    input: { id: string; userId: string; at: Date },
): Promise<void> {
    await executor
        .update(recordings)
        .set({ deletedAt: input.at, updatedAt: input.at })
        .where(
            and(
                eq(recordings.id, input.id),
                eq(recordings.userId, input.userId),
            ),
        );
    await markItemDeleted(executor, input);
}

/** Tombstones an item at `at`, releasing any Learn hold. */
export async function markItemDeleted(
    executor: Executor,
    input: { id: string; userId: string; at: Date },
): Promise<void> {
    await executor
        .update(chatterItems)
        .set({ deletedAt: input.at, summaryDueAt: null, updatedAt: input.at })
        .where(
            and(
                eq(chatterItems.id, input.id),
                eq(chatterItems.userId, input.userId),
            ),
        );
}

/**
 * Sets an item's (encrypted) title; `editedAt` marks it a person's. A
 * recording's own `updatedAt` moves with it, since the v1 list pages by
 * that column and a renamed recording is a changed one.
 */
export async function setItemTitle(
    executor: Executor,
    input: {
        id: string;
        userId: string;
        title: string;
        editedAt?: Date | null;
        at?: Date;
        /** False when the caller moved the recording's `updatedAt` itself. */
        touch?: boolean;
    },
): Promise<void> {
    const at = input.at ?? new Date();
    await executor
        .update(chatterItems)
        .set({
            title: input.title,
            ...(input.editedAt !== undefined
                ? { titleEditedAt: input.editedAt }
                : {}),
            updatedAt: at,
        })
        .where(
            and(
                eq(chatterItems.id, input.id),
                eq(chatterItems.userId, input.userId),
            ),
        );
    if (input.touch !== false) {
        await touchRecording(executor, input.id, input.userId, at);
    }
}

/** Moves a recording's `updatedAt` (no-op for other kinds). */
export async function touchRecording(
    executor: Executor,
    id: string,
    userId: string,
    at: Date = new Date(),
): Promise<void> {
    await executor
        .update(recordings)
        .set({ updatedAt: at })
        .where(and(eq(recordings.id, id), eq(recordings.userId, userId)));
}
