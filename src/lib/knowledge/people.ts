import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    people,
    personNotes,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { planSpeakerMerge } from "@/lib/knowledge/merge-plan";
import { orgOwnedCondition } from "@/lib/knowledge/org-people";

/** The bound on `people.displayName`, shared by every route that writes it. */
export const MAX_DISPLAY_NAME_LENGTH = 200;

/**
 * `personal` people belong to one account. `org` people are the
 * Organization's: one record everyone names speakers with, curated by the
 * organization account.
 */
export type PersonScope = "personal" | "org";

/** A person as feature code sees them: decrypted, never the stored row. */
export interface Person {
    id: string;
    displayName: string;
    primaryEmail: string | null;
    /**
     * The viewer's notes. For an Organization person these are the viewer's
     * own private notes, never anyone else's.
     */
    notes: string | null;
    /**
     * Set when this row is a tombstone left behind by a merge, naming the
     * person it redirects to. `listPeople` and `findPersonByEmail` filter
     * these out; `getPerson` does not, because callers hold ids that may
     * have been merged away since they were read, and answering "not found"
     * would lose the redirect that exists to prevent exactly that.
     */
    mergedIntoId: string | null;
    scope: PersonScope;
    createdAt: Date;
    updatedAt: Date;
}

export interface CreatePersonArgs {
    userId: string;
    displayName: string;
    primaryEmail?: string | null;
    notes?: string | null;
    /** Who named an Organization person; `userId` is then the org account. */
    createdByUserId?: string | null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "select">;

interface PersonRow {
    id: string;
    userId: string;
    ownerRole: string;
    displayName: string;
    primaryEmail: string | null;
    notes: string | null;
    mergedIntoId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const personColumns = {
    id: people.id,
    userId: people.userId,
    ownerRole: users.role,
    displayName: people.displayName,
    primaryEmail: people.primaryEmail,
    notes: people.notes,
    mergedIntoId: people.mergedIntoId,
    createdAt: people.createdAt,
    updatedAt: people.updatedAt,
};

export { orgOwnedCondition };

/** SQL predicate: a person `userId` may see -- their own, or the Organization's. */
export function peopleVisibleTo(userId: string) {
    return or(eq(people.userId, userId), orgOwnedCondition(people.userId));
}

function toPerson(row: PersonRow, viewerNotes?: string | null): Person {
    const scope: PersonScope = row.ownerRole === "org" ? "org" : "personal";
    const notes = scope === "org" ? (viewerNotes ?? null) : row.notes;
    return {
        id: row.id,
        displayName: decryptText(row.displayName),
        primaryEmail: row.primaryEmail ? decryptText(row.primaryEmail) : null,
        notes: notes ? decryptText(notes) : null,
        mergedIntoId: row.mergedIntoId,
        scope,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

async function readPersonRow(
    executor: Executor,
    personId: string,
): Promise<PersonRow | null> {
    const [row] = await executor
        .select(personColumns)
        .from(people)
        .innerJoin(users, eq(users.id, people.userId))
        .where(eq(people.id, personId))
        .limit(1);
    return row ?? null;
}

async function viewerNotesFor(
    userId: string,
    personIds: string[],
): Promise<Map<string, string>> {
    if (personIds.length === 0) return new Map();
    const rows = await db
        .select({ personId: personNotes.personId, notes: personNotes.notes })
        .from(personNotes)
        .where(
            and(
                eq(personNotes.userId, userId),
                inArray(personNotes.personId, personIds),
            ),
        );
    return new Map(rows.map((row) => [row.personId, row.notes]));
}

/**
 * Create a person from a name the user typed.
 *
 * Deliberately requires no external identifier: naming a speaker in a
 * transcript supplies a name and nothing else. An email is optional, and
 * only some people will ever have one.
 */
export async function createPerson({
    userId,
    displayName,
    primaryEmail,
    notes,
    createdByUserId,
}: CreatePersonArgs): Promise<Person> {
    const trimmedName = displayName.trim();
    if (!trimmedName) {
        throw new Error("A person needs a name");
    }
    const email = primaryEmail?.trim() || null;

    const [created] = await db
        .insert(people)
        .values({
            userId,
            displayName: encryptText(trimmedName),
            primaryEmail: email ? encryptText(email) : null,
            primaryEmailHash: email ? lookupHash(email) : null,
            notes: notes?.trim() ? encryptText(notes.trim()) : null,
            createdByUserId: createdByUserId ?? null,
        })
        .returning({ id: people.id });

    const row = created ? await readPersonRow(db, created.id) : null;
    if (!row) throw new Error("Person was not created");
    return toPerson(row);
}

/**
 * Find a person by email address among those `userId` can see.
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
        .innerJoin(users, eq(users.id, people.userId))
        .where(
            and(
                peopleVisibleTo(userId),
                eq(people.primaryEmailHash, lookupHash(email)),
                isNull(people.mergedIntoId),
            ),
        )
        .limit(1);

    return row ? toPerson(row) : null;
}

/**
 * The people `userId` can name speakers with: their own, and the
 * Organization's. Most recently updated first; tombstones excluded.
 */
export async function listPeople(userId: string): Promise<Person[]> {
    const rows = await db
        .select(personColumns)
        .from(people)
        .innerJoin(users, eq(users.id, people.userId))
        .where(and(peopleVisibleTo(userId), isNull(people.mergedIntoId)))
        .orderBy(sql`${people.updatedAt} desc`);

    const notes = await viewerNotesFor(
        userId,
        rows.filter((row) => row.ownerRole === "org").map((row) => row.id),
    );
    return rows.map((row) => toPerson(row, notes.get(row.id)));
}

/** Look up a person by id, tombstones included -- see `Person.mergedIntoId`. */
export async function getPerson(
    userId: string,
    personId: string,
): Promise<Person | null> {
    const [row] = await db
        .select(personColumns)
        .from(people)
        .innerJoin(users, eq(users.id, people.userId))
        .where(and(peopleVisibleTo(userId), eq(people.id, personId)))
        .limit(1);
    if (!row) return null;
    const notes =
        row.ownerRole === "org"
            ? (await viewerNotesFor(userId, [row.id])).get(row.id)
            : undefined;
    return toPerson(row, notes);
}

function curatorOnly(): AppError {
    return new AppError(
        ErrorCode.FORBIDDEN,
        "Only the organization account can change an Organization person",
        403,
    );
}

function personNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Person not found", 404);
}

/**
 * A person `actorId` may change: their own, which for the organization
 * account are the Organization's people. Everyone else may see an
 * Organization person but not change it.
 */
async function requireManageable(
    executor: Executor,
    actorId: string,
    personId: string,
): Promise<PersonRow> {
    const row = await readPersonRow(executor, personId);
    if (!row) throw personNotFound();
    if (row.userId === actorId) return row;
    if (row.ownerRole === "org") throw curatorOnly();
    throw personNotFound();
}

/**
 * Rename a person or change their email.
 *
 * An Organization person is renamed for everyone, in every recording that
 * names them -- private recordings included -- which is why only the
 * organization account may do it.
 */
export async function updatePerson(
    actorId: string,
    personId: string,
    changes: { displayName?: string; primaryEmail?: string | null },
): Promise<Person> {
    await db.transaction(async (tx) => {
        // Under the promotion lock: a promotion checks email uniqueness
        // against the Organization's people and must not race an edit of it.
        await lockOrgPeople(tx);
        await updatePersonInTx(tx, actorId, personId, changes);
    });
    const updated = await getPerson(actorId, personId);
    if (!updated) throw personNotFound();
    return updated;
}

async function updatePersonInTx(
    tx: Tx,
    actorId: string,
    personId: string,
    changes: { displayName?: string; primaryEmail?: string | null },
): Promise<void> {
    const row = await requireManageable(tx, actorId, personId);
    if (row.mergedIntoId) throw personNotFound();

    const set: Partial<typeof people.$inferInsert> = { updatedAt: new Date() };
    if (changes.displayName !== undefined) {
        const name = changes.displayName.trim();
        if (!name) {
            throw new AppError(
                ErrorCode.MISSING_REQUIRED_FIELD,
                "A person needs a name",
                400,
                { field: "displayName" },
            );
        }
        set.displayName = encryptText(name);
    }
    if (changes.primaryEmail !== undefined) {
        const email = changes.primaryEmail?.trim() || null;
        if (email) {
            const holder = await findPersonByEmail(actorId, email);
            if (holder && holder.id !== personId) {
                throw new AppError(
                    ErrorCode.CONFLICT,
                    `${holder.displayName} already has that email address`,
                    409,
                    { field: "primaryEmail" },
                );
            }
        }
        set.primaryEmail = email ? encryptText(email) : null;
        set.primaryEmailHash = email ? lookupHash(email) : null;
    }

    await tx.update(people).set(set).where(eq(people.id, personId));
}

/**
 * Move `loserId`'s attributions onto `winnerId` and leave a tombstone.
 *
 * Works on person ids alone: an Organization person is named in many
 * accounts' transcripts, so every attribution row is moved, whoever's it
 * is. Callers authorize first.
 */
async function mergeInTx(
    tx: Tx,
    winnerId: string,
    loserId: string,
): Promise<void> {
    const attributionColumns = {
        id: transcriptSpeakers.id,
        transcriptionId: transcriptSpeakers.transcriptionId,
        label: transcriptSpeakers.label,
        status: transcriptSpeakers.status,
    };
    const winners = await tx
        .select(attributionColumns)
        .from(transcriptSpeakers)
        .where(eq(transcriptSpeakers.personId, winnerId));
    const losers = await tx
        .select(attributionColumns)
        .from(transcriptSpeakers)
        .where(eq(transcriptSpeakers.personId, loserId));

    const plan = planSpeakerMerge(winners, losers);
    const dropped = [...plan.dropLoserIds, ...plan.dropWinnerIds];
    if (dropped.length > 0) {
        await tx
            .delete(transcriptSpeakers)
            .where(inArray(transcriptSpeakers.id, dropped));
    }
    if (plan.repointLoserIds.length > 0) {
        await tx
            .update(transcriptSpeakers)
            .set({ personId: winnerId, updatedAt: new Date() })
            .where(inArray(transcriptSpeakers.id, plan.repointLoserIds));
    }

    // Everyone's private notes about the loser follow the attributions.
    const loserNotes = await tx
        .select({ userId: personNotes.userId, notes: personNotes.notes })
        .from(personNotes)
        .where(eq(personNotes.personId, loserId));
    for (const note of loserNotes) {
        await appendOverlayNotes(tx, winnerId, note.userId, note.notes);
    }
    if (loserNotes.length > 0) {
        await tx.delete(personNotes).where(eq(personNotes.personId, loserId));
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
        .where(eq(people.id, loserId));
    await tx
        .update(people)
        .set({ mergedIntoId: winnerId, updatedAt: new Date() })
        .where(eq(people.mergedIntoId, loserId));
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
 *
 * `actorId` must be able to change the loser: their own person, or, for the
 * organization account, an Organization person. The target may be the
 * actor's own or an Organization person, so anyone can fold a private
 * duplicate into the shared record, but never the reverse.
 */
export async function mergePeople(
    actorId: string,
    keepId: string,
    loserId: string,
): Promise<void> {
    if (keepId === loserId) return;

    await db.transaction(async (tx) => {
        const loser = await requireManageable(tx, actorId, loserId);
        const keep = await readPersonRow(tx, keepId);
        if (!keep || (keep.userId !== actorId && keep.ownerRole !== "org")) {
            throw personNotFound();
        }
        if (loser.ownerRole === "org" && keep.ownerRole !== "org") {
            throw curatorOnly();
        }

        // Every tombstone is repointed at the surviving person when its own
        // target is merged away (the collapse in `mergeInTx`), so a redirect
        // is never more than one hop deep and following it cannot loop.
        const winnerId = keep.mergedIntoId ?? keepId;
        if (winnerId === loserId) return;
        await mergeInTx(tx, winnerId, loserId);
        if (loser.ownerRole !== "org" && keep.ownerRole === "org") {
            await moveNotesToOverlay(tx, loser, winnerId);
        }
    });
}

/**
 * Erase a person.
 *
 * A named third party asking to be removed is a data-subject request, so it
 * has to be one action. For a private person, attributions cascade with the
 * row; the transcript keeps its raw `speaker_N` label and simply loses the
 * overlay, which is the right outcome -- the recording is not the thing
 * being erased. An Organization person is named in other people's
 * transcripts too, so their attributions are unlinked rather than deleted.
 *
 * The tombstones of anyone merged into this person go with them. They hold
 * the same human's encrypted name and email, `mergedIntoId` carries no
 * foreign key so nothing cascades to them, and no surface lists them -- so
 * leaving them behind would quietly keep the data the request is about.
 */
export async function deletePerson(
    actorId: string,
    personId: string,
): Promise<void> {
    await db.transaction(async (tx) => {
        const row = await requireManageable(tx, actorId, personId);
        if (row.ownerRole === "org") {
            await tx
                .update(transcriptSpeakers)
                .set({ personId: null, updatedAt: new Date() })
                .where(eq(transcriptSpeakers.personId, personId));
        }
        await tx
            .delete(people)
            .where(
                or(eq(people.id, personId), eq(people.mergedIntoId, personId)),
            );
    });
}

/**
 * Add `notes` (ciphertext) to `userId`'s private notes on a person, after
 * whatever they already wrote there -- two records of one human each carried
 * something, and neither may be dropped.
 */
async function appendOverlayNotes(
    tx: Tx,
    personId: string,
    userId: string,
    notes: string,
): Promise<void> {
    const [current] = await tx
        .select({ id: personNotes.id, notes: personNotes.notes })
        .from(personNotes)
        .where(
            and(
                eq(personNotes.personId, personId),
                eq(personNotes.userId, userId),
            ),
        )
        .limit(1);
    if (!current) {
        await tx.insert(personNotes).values({ personId, userId, notes });
        return;
    }
    const combined = [decryptText(current.notes), decryptText(notes)]
        .filter((text) => text.trim())
        .join("\n\n");
    await tx
        .update(personNotes)
        .set({ notes: encryptText(combined), updatedAt: new Date() })
        .where(eq(personNotes.id, current.id));
}

async function moveNotesToOverlay(
    tx: Tx,
    from: Pick<PersonRow, "id" | "userId" | "notes">,
    orgPersonId: string,
): Promise<void> {
    if (!from.notes) return;
    await appendOverlayNotes(tx, orgPersonId, from.userId, from.notes);
    await tx
        .update(people)
        .set({ notes: null, updatedAt: new Date() })
        .where(eq(people.id, from.id));
}

/** Store `userId`'s private notes on an Organization person. */
export async function addPersonNotes(
    personId: string,
    userId: string,
    notes: string,
): Promise<void> {
    const trimmed = notes.trim();
    if (!trimmed) return;
    await db.transaction((tx) =>
        appendOverlayNotes(tx, personId, userId, encryptText(trimmed)),
    );
}

/**
 * Make a private person an Organization person.
 *
 * Promotion reassigns the row rather than copying it, so every attribution
 * -- the owner's private ones included -- keeps pointing at the same id and
 * the owner's knowledge base cannot drift from the Organization's. When the
 * Organization already knows someone with the same email, the private
 * record is folded into theirs instead. The owner's notes are never
 * promoted: they move to that owner's private overlay.
 *
 * Returns the id of the Organization person. Permanent: unsharing the
 * recording that caused it does not demote anyone.
 */
async function promotePersonInTx(
    tx: Tx,
    personId: string,
    orgUserId: string,
): Promise<string | null> {
    const row = await readPersonRow(tx, personId);
    if (!row) return null;
    if (row.mergedIntoId) {
        return promotePersonInTx(tx, row.mergedIntoId, orgUserId);
    }
    if (row.userId === orgUserId || row.ownerRole === "org") return row.id;

    const [emailRow] = await tx
        .select({ hash: people.primaryEmailHash })
        .from(people)
        .where(eq(people.id, row.id))
        .limit(1);
    if (emailRow?.hash) {
        const [known] = await tx
            .select({ id: people.id })
            .from(people)
            .where(
                and(
                    eq(people.userId, orgUserId),
                    eq(people.primaryEmailHash, emailRow.hash),
                    isNull(people.mergedIntoId),
                ),
            )
            .limit(1);
        if (known) {
            await mergeInTx(tx, known.id, row.id);
            await moveNotesToOverlay(tx, row, known.id);
            return known.id;
        }
    }

    await moveNotesToOverlay(tx, row, row.id);
    await tx
        .update(people)
        .set({
            userId: orgUserId,
            createdByUserId: row.userId,
            updatedAt: new Date(),
        })
        .where(eq(people.id, row.id));
    return row.id;
}

/**
 * Serialize promotions, so two recordings shared at once cannot both create
 * an Organization person for the same email.
 */
async function lockOrgPeople(tx: Tx): Promise<void> {
    await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('riffado:org-people'))`,
    );
}

/** Promote one person, e.g. after it was confirmed on a shared transcript. */
export async function promotePerson(
    personId: string,
    orgUserId: string,
): Promise<string | null> {
    return db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        return promotePersonInTx(tx, personId, orgUserId);
    });
}

/**
 * Promote everyone confirmed on the owner's transcripts of a recording.
 *
 * Called when the recording is shared and the Organization view shows the
 * owner's transcripts: each name visible there becomes an Organization
 * person. Suggestions are left alone -- they are the owner's to review.
 */
export async function promoteRecordingPeople(
    recordingId: string,
    ownerUserId: string,
    orgUserId: string,
): Promise<void> {
    await db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        const rows = await tx
            .selectDistinct({ personId: transcriptSpeakers.personId })
            .from(transcriptSpeakers)
            .innerJoin(
                transcriptions,
                eq(transcriptions.id, transcriptSpeakers.transcriptionId),
            )
            .innerJoin(people, eq(people.id, transcriptSpeakers.personId))
            .where(
                and(
                    eq(transcriptions.recordingId, recordingId),
                    eq(transcriptions.userId, ownerUserId),
                    eq(transcriptSpeakers.status, "confirmed"),
                    eq(people.userId, ownerUserId),
                ),
            );
        for (const { personId } of rows) {
            if (personId) await promotePersonInTx(tx, personId, orgUserId);
        }
    });
}
