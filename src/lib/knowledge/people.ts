import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { people, transcriptSpeakers } from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { planSpeakerMerge } from "@/lib/knowledge/merge-plan";

/** A person as feature code sees them: decrypted, never the stored row. */
export interface Person {
    id: string;
    displayName: string;
    primaryEmail: string | null;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface CreatePersonArgs {
    userId: string;
    displayName: string;
    primaryEmail?: string | null;
    notes?: string | null;
}

interface PersonRow {
    id: string;
    displayName: string;
    primaryEmail: string | null;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const personColumns = {
    id: people.id,
    displayName: people.displayName,
    primaryEmail: people.primaryEmail,
    notes: people.notes,
    createdAt: people.createdAt,
    updatedAt: people.updatedAt,
};

function toPerson(row: PersonRow): Person {
    return {
        id: row.id,
        displayName: decryptText(row.displayName),
        primaryEmail: row.primaryEmail ? decryptText(row.primaryEmail) : null,
        notes: row.notes ? decryptText(row.notes) : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

/**
 * Create a person from a name the user typed.
 *
 * This is the Phase 1 path and it deliberately requires no external
 * identifier: naming a speaker in a transcript supplies a name and nothing
 * else. An email is optional and only some people will ever have one.
 */
export async function createPerson({
    userId,
    displayName,
    primaryEmail,
    notes,
}: CreatePersonArgs): Promise<Person> {
    const trimmedName = displayName.trim();
    if (!trimmedName) {
        throw new Error("A person needs a name");
    }
    const email = primaryEmail?.trim() || null;

    const [row] = await db
        .insert(people)
        .values({
            userId,
            displayName: encryptText(trimmedName),
            primaryEmail: email ? encryptText(email) : null,
            primaryEmailHash: email ? lookupHash(email) : null,
            notes: notes?.trim() ? encryptText(notes.trim()) : null,
        })
        .returning(personColumns);

    return toPerson(row);
}

/**
 * Find a person by email address.
 *
 * Matches on the HMAC rather than the stored ciphertext, which is not
 * deterministic and could not be compared. Tombstoned losers of a merge are
 * excluded so a stale address never resolves to a row the user has already
 * folded away.
 */
export async function findPersonByEmail(
    userId: string,
    email: string,
): Promise<Person | null> {
    const [row] = await db
        .select(personColumns)
        .from(people)
        .where(
            and(
                eq(people.userId, userId),
                eq(people.primaryEmailHash, lookupHash(email)),
                isNull(people.mergedIntoId),
            ),
        )
        .limit(1);

    return row ? toPerson(row) : null;
}

/** One user's people, most recently updated first. Tombstones excluded. */
export async function listPeople(userId: string): Promise<Person[]> {
    const rows = await db
        .select(personColumns)
        .from(people)
        .where(and(eq(people.userId, userId), isNull(people.mergedIntoId)))
        .orderBy(sql`${people.updatedAt} desc`);

    return rows.map(toPerson);
}

export async function getPerson(
    userId: string,
    personId: string,
): Promise<Person | null> {
    const [row] = await db
        .select(personColumns)
        .from(people)
        .where(and(eq(people.userId, userId), eq(people.id, personId)))
        .limit(1);

    return row ? toPerson(row) : null;
}

/**
 * Fold `loserId` into `keepId`.
 *
 * Two people become one constantly: a name typed into the speaker picker and
 * the same human arriving later from a calendar invite are different rows
 * until somebody says otherwise.
 *
 * The hard part is not moving rows, it is the ones that cannot move.
 * `transcript_speakers` is unique on `(transcriptionId, label)`, so when both
 * people are attributed in the same transcript the loser's row has nowhere to
 * go. `planSpeakerMerge` decides which survives; the losing row is
 * dropped rather than repointed.
 *
 * The losing person row is kept as a tombstone carrying `mergedIntoId` so
 * that anything still holding the old id resolves to the winner instead of
 * dangling.
 *
 * `keepId` may itself be a tombstone -- the picker and the API both accept an
 * id that was merged away since the caller read it -- so it is resolved to
 * the person it redirects to before anything moves.
 */
export async function mergePeople(
    userId: string,
    keepId: string,
    loserId: string,
): Promise<void> {
    if (keepId === loserId) return;

    await db.transaction(async (tx) => {
        const rows = await tx
            .select({ id: people.id, mergedIntoId: people.mergedIntoId })
            .from(people)
            .where(and(eq(people.userId, userId), eq(people.id, keepId)))
            .limit(1);
        if (rows.length === 0) {
            throw new Error("Merge target does not exist");
        }

        // Every tombstone is repointed at the surviving person when its own
        // target is merged away (the collapse below), so a redirect is never
        // more than one hop deep and following it cannot loop.
        const winnerId = rows[0].mergedIntoId ?? keepId;
        if (winnerId === loserId) return;

        const winners = await tx
            .select({
                id: transcriptSpeakers.id,
                transcriptionId: transcriptSpeakers.transcriptionId,
                label: transcriptSpeakers.label,
                status: transcriptSpeakers.status,
            })
            .from(transcriptSpeakers)
            .where(
                and(
                    eq(transcriptSpeakers.userId, userId),
                    eq(transcriptSpeakers.personId, winnerId),
                ),
            );

        const losers = await tx
            .select({
                id: transcriptSpeakers.id,
                transcriptionId: transcriptSpeakers.transcriptionId,
                label: transcriptSpeakers.label,
                status: transcriptSpeakers.status,
            })
            .from(transcriptSpeakers)
            .where(
                and(
                    eq(transcriptSpeakers.userId, userId),
                    eq(transcriptSpeakers.personId, loserId),
                ),
            );

        const plan = planSpeakerMerge(winners, losers);

        for (const id of plan.dropLoserIds) {
            await tx
                .delete(transcriptSpeakers)
                .where(
                    and(
                        eq(transcriptSpeakers.id, id),
                        eq(transcriptSpeakers.userId, userId),
                    ),
                );
        }
        for (const id of plan.dropWinnerIds) {
            await tx
                .delete(transcriptSpeakers)
                .where(
                    and(
                        eq(transcriptSpeakers.id, id),
                        eq(transcriptSpeakers.userId, userId),
                    ),
                );
        }
        for (const id of plan.repointLoserIds) {
            await tx
                .update(transcriptSpeakers)
                .set({ personId: winnerId, updatedAt: new Date() })
                .where(
                    and(
                        eq(transcriptSpeakers.id, id),
                        eq(transcriptSpeakers.userId, userId),
                    ),
                );
        }

        // Chains collapse to the final winner rather than forming a linked
        // list nobody walks: anything already pointing at the loser is
        // repointed in the same transaction.
        //
        // The lookup key goes with the name it belonged to. A tombstone
        // exists to redirect an id, and holding the unique email hash would
        // reserve an address nothing displays and nothing can release.
        await tx
            .update(people)
            .set({
                mergedIntoId: winnerId,
                primaryEmailHash: null,
                updatedAt: new Date(),
            })
            .where(and(eq(people.userId, userId), eq(people.id, loserId)));

        await tx
            .update(people)
            .set({ mergedIntoId: winnerId, updatedAt: new Date() })
            .where(
                and(
                    eq(people.userId, userId),
                    eq(people.mergedIntoId, loserId),
                ),
            );
    });
}

/**
 * Erase a person.
 *
 * A named third party asking to be removed is a data-subject request, so it
 * has to be one action. Attributions cascade with the row; the transcript
 * keeps its raw `speaker_N` label and simply loses the overlay, which is the
 * right outcome -- the recording is not the thing being erased.
 *
 * The tombstones of anyone merged into this person go with them. They hold
 * the same human's encrypted name and email, `mergedIntoId` carries no
 * foreign key so nothing cascades to them, and no surface lists them -- so
 * leaving them behind would quietly keep the data the request is about.
 */
export async function deletePerson(
    userId: string,
    personId: string,
): Promise<void> {
    await db
        .delete(people)
        .where(
            and(
                eq(people.userId, userId),
                or(eq(people.id, personId), eq(people.mergedIntoId, personId)),
            ),
        );
}
