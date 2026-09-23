import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
    people,
    recordings,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { orgOwnedCondition } from "@/lib/knowledge/org-people";
import { promotePerson } from "@/lib/knowledge/people";
import { speakerAnchorId } from "@/lib/knowledge/speaker-references";
import { isRecordingShared } from "@/lib/sharing/shared";
import {
    parseSpeakerTurns,
    speakerOrder,
} from "@/lib/transcription/diarization";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

type TranscriptionRow = typeof transcriptions.$inferSelect;

export interface OrgTranscriptOwners {
    ownerUserId: string;
    /** The organization account, owner of the Organization view's rows. */
    contentUserId: string;
}

function orderedSpeakers(row: Pick<TranscriptionRow, "text" | "turns">) {
    const turns = readTranscriptTurns(row);
    if (turns) {
        return [...new Set(turns.map((turn) => turn.speaker).filter(Boolean))];
    }
    const parsed = parseSpeakerTurns(decryptText(row.text));
    return parsed ? speakerOrder(parsed) : [];
}

/**
 * The Organization view's own transcript for `source`, created on demand.
 *
 * Until someone edits it, the Organization view reads the owner's
 * transcripts. Naming a speaker there must not touch the owner's private
 * attributions, so the first edit copies the owner's transcripts -- every
 * source, so switching sources in the view keeps working -- into the
 * organization's rows, with the names already confirmed on them, and the
 * edit lands on the copy.
 *
 * Copies are inserted only where the organization has no row yet, under the
 * recording lock the content upserts take, so a concurrent Organization
 * re-transcription is never overwritten by the owner's older text.
 */
export async function ensureOrgTranscript(
    recordingId: string,
    source: string,
    owners: OrgTranscriptOwners,
    actorUserId: string,
): Promise<TranscriptionRow> {
    const findOwn = async () =>
        (
            await db
                .select()
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, recordingId),
                        eq(transcriptions.userId, owners.contentUserId),
                        eq(transcriptions.source, source),
                    ),
                )
                .limit(1)
        )[0];
    const existing = await findOwn();
    if (existing) return existing;

    const copies = await db.transaction(async (tx) => {
        const [recording] = await tx
            .select({ deletedAt: recordings.deletedAt })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, owners.ownerUserId),
                ),
            )
            .for("update")
            .limit(1);
        if (
            !recording ||
            recording.deletedAt ||
            !(await isRecordingShared(recordingId, owners.contentUserId, tx))
        ) {
            return null;
        }
        const originals = await tx
            .select()
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, recordingId),
                    eq(transcriptions.userId, owners.ownerUserId),
                ),
            );
        const made: { original: TranscriptionRow; copyId: string }[] = [];
        for (const original of originals) {
            const [copy] = await tx
                .insert(transcriptions)
                .values({
                    recordingId,
                    userId: owners.contentUserId,
                    text: original.text,
                    turns: original.turns,
                    // The same transcript, so its topics still fit it.
                    topics: original.topics,
                    detectedLanguage: original.detectedLanguage,
                    transcriptionType: original.transcriptionType,
                    provider: original.provider,
                    model: original.model,
                    source: original.source,
                    producedByUserId: actorUserId,
                })
                .onConflictDoNothing()
                .returning({ id: transcriptions.id });
            if (copy) made.push({ original, copyId: copy.id });
        }
        return made;
    });
    if (copies === null) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }

    for (const { original, copyId } of copies) {
        const confirmed = await db
            .select()
            .from(transcriptSpeakers)
            .where(
                and(
                    eq(transcriptSpeakers.transcriptionId, original.id),
                    eq(transcriptSpeakers.status, "confirmed"),
                ),
            );
        const rows = [];
        for (const attribution of confirmed) {
            // Only names the Organization knows travel; a private person
            // still on the owner's transcript is promoted first, which is
            // what showing it in the Organization view already implied.
            const personId = attribution.personId
                ? await promotePerson(
                      attribution.personId,
                      owners.contentUserId,
                  )
                : null;
            rows.push({
                userId: owners.contentUserId,
                transcriptionId: copyId,
                label: attribution.label,
                personId,
                source: attribution.source,
                status: attribution.status,
                confidence: attribution.confidence,
                evidenceStartMs: attribution.evidenceStartMs,
            });
        }
        if (rows.length > 0) {
            await db
                .insert(transcriptSpeakers)
                .values(rows)
                .onConflictDoNothing();
        }
    }

    const own = await findOwn();
    if (!own) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "No transcript to attribute",
            404,
        );
    }
    return own;
}

/**
 * Names from the transcript an Organization re-transcription replaced.
 *
 * Captured before the run writes, applied after: see
 * `applyCarriedSpeakerNames`.
 */
export interface CarriedSpeakerNames {
    speakers: string[];
    names: {
        label: string;
        personId: string;
        evidenceStartMs: number | null;
    }[];
}

/**
 * Read the confirmed Organization-visible names of the transcript the
 * Organization view showed before a re-run: its own, or the owner's while it
 * had none.
 */
export async function captureSpeakerNames(
    recordingId: string,
    owners: OrgTranscriptOwners,
): Promise<CarriedSpeakerNames | null> {
    const candidates = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                inArray(transcriptions.userId, [
                    owners.contentUserId,
                    owners.ownerUserId,
                ]),
            ),
        );
    const previous =
        candidates.find(
            (row) =>
                row.userId === owners.contentUserId && row.source === "riffado",
        ) ??
        candidates.find((row) => row.userId === owners.contentUserId) ??
        candidates.find((row) => row.source === "riffado") ??
        candidates[0];
    if (!previous) return null;

    const names = await db
        .select({
            label: transcriptSpeakers.label,
            personId: transcriptSpeakers.personId,
            evidenceStartMs: transcriptSpeakers.evidenceStartMs,
        })
        .from(transcriptSpeakers)
        .innerJoin(people, eq(people.id, transcriptSpeakers.personId))
        .where(
            and(
                eq(transcriptSpeakers.transcriptionId, previous.id),
                eq(transcriptSpeakers.status, "confirmed"),
                // Private people of the owner never ride along.
                orgOwnedCondition(people.userId),
            ),
        );
    return {
        speakers: orderedSpeakers(previous),
        names: names.flatMap((row) =>
            row.personId
                ? [
                      {
                          label: row.label,
                          personId: row.personId,
                          evidenceStartMs: row.evidenceStartMs,
                      },
                  ]
                : [],
        ),
    };
}

/**
 * Offer the carried names on the new Organization transcript as suggestions.
 *
 * A new diarization may number the same people differently, so a name that
 * was confirmed against the old labels is only a guess against the new ones.
 * Mapped by speaker order when both runs found as many speakers; anyone who
 * can see the view confirms them. The transcript's previous attributions are
 * replaced either way: they described text that no longer exists.
 */
export async function applyCarriedSpeakerNames(
    carried: CarriedSpeakerNames | null,
    transcriptionId: string,
    orgUserId: string,
): Promise<void> {
    await db
        .delete(transcriptSpeakers)
        .where(eq(transcriptSpeakers.transcriptionId, transcriptionId));
    if (!carried || carried.names.length === 0) return;

    const [target] = await db
        .select()
        .from(transcriptions)
        .where(eq(transcriptions.id, transcriptionId))
        .limit(1);
    if (!target) return;
    const next = orderedSpeakers(target);
    if (next.length === 0 || next.length !== carried.speakers.length) return;

    const rows = carried.names.flatMap((name) => {
        const index = carried.speakers.findIndex(
            (label) => speakerAnchorId(label) === speakerAnchorId(name.label),
        );
        if (index < 0) return [];
        return [
            {
                userId: orgUserId,
                transcriptionId,
                label: next[index],
                personId: name.personId,
                source: "heuristic" as const,
                status: "suggested" as const,
                evidenceStartMs: name.evidenceStartMs,
            },
        ];
    });
    if (rows.length > 0) {
        await db.insert(transcriptSpeakers).values(rows).onConflictDoNothing();
    }
}
