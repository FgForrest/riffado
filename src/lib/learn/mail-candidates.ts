import type { ContentParticipant } from "@/lib/content/types";
import { type MailPart, mailPartAt, mailRangeAt } from "@/lib/learn/mail-parts";
import type { LearnObject, LearnSubject } from "@/lib/learn/output";
import type { ReviewCandidate } from "@/lib/learn/validate";
import type { NewRecordPayload } from "@/lib/learn/validate-new-records";

/** Where in a mail's content something was written: one segment's range. */
export interface MailTextAnchor {
    segmentIndex: number;
    charStart: number;
    charEnd: number;
}

/**
 * How far to take what a mail says: a quoted part was written earlier by
 * someone else and only quoted (D4); a sender nothing verified may not be
 * who they say. Either starts unticked in the review.
 */
export type MailProvenance = "quoted" | "unverified" | null;

export interface MailFactPayload {
    factId?: string;
    subject: LearnSubject;
    relationKey: string;
    object: LearnObject;
    speakerLabel: string | null;
    replaces?: { factId: string; object: LearnObject };
    text: MailTextAnchor;
    provenance: MailProvenance;
}

export interface MailPhrasePayload {
    phrase: string;
    subject: LearnSubject;
    object?: { personId: string } | { entityId: string } | { newRef: string };
    objectKind: "entity" | "literal";
    count: number;
    text: MailTextAnchor;
    provenance: MailProvenance;
}

export type MailNewRecordPayload = Omit<NewRecordPayload, "evidenceMs"> & {
    evidence: MailTextAnchor[];
};

/** A review item of a run on a mail, as stored: never a time. */
export type MailReviewCandidate =
    | {
          kind: "new_record";
          fingerprint: string;
          preTicked: false;
          payload: MailNewRecordPayload;
      }
    | {
          kind: "fact" | "known_fact";
          fingerprint: string;
          preTicked: boolean;
          dependsOnLabel?: string;
          payload: MailFactPayload;
      }
    | {
          kind: "relation_phrase";
          fingerprint: string;
          preTicked: false;
          dependsOnLabel?: string;
          payload: MailPhrasePayload;
      };

function anchorOf(part: MailPart): MailTextAnchor {
    return {
        segmentIndex: part.segmentIndex,
        charStart: part.charStart,
        charEnd: part.charEnd,
    };
}

function provenanceOf(
    part: MailPart,
    participants: readonly ContentParticipant[],
): MailProvenance {
    if (part.role === "quoted" || part.role === "quoted_signature") {
        return "quoted";
    }
    const writer = participants.find(
        (participant) => participant.ref === part.participantRef,
    );
    return writer?.authenticated ? null : "unverified";
}

/**
 * The candidates a run validated on a mail's parts (`mailLearnParts`), as a
 * mail's review stores them: each time read back as the range of the
 * mail's text it stands for, with its provenance. Speaker suggestions and
 * corrections have no place in a mail and are dropped.
 */
export function mailCandidates(
    items: readonly ReviewCandidate[],
    parts: readonly MailPart[],
    participants: readonly ContentParticipant[],
): MailReviewCandidate[] {
    const candidates: MailReviewCandidate[] = [];
    for (const item of items) {
        if (item.kind === "new_record") {
            const { evidenceMs, ...rest } = item.payload;
            const evidence = evidenceMs.flatMap((ms) => {
                const part = mailPartAt(parts, ms);
                return part ? [anchorOf(part)] : [];
            });
            if (evidence.length === 0) continue;
            candidates.push({
                kind: "new_record",
                fingerprint: item.fingerprint,
                preTicked: false,
                payload: { ...rest, evidence },
            });
            continue;
        }
        if (item.kind === "fact" || item.kind === "known_fact") {
            const { startMs, endMs, ...rest } = item.payload;
            const part = mailRangeAt(parts, startMs, endMs);
            if (!part) continue;
            const provenance = provenanceOf(part, participants);
            candidates.push({
                kind: item.kind,
                fingerprint: item.fingerprint,
                preTicked: item.preTicked && provenance === null,
                ...(item.dependsOnLabel
                    ? { dependsOnLabel: item.dependsOnLabel }
                    : {}),
                payload: { ...rest, text: anchorOf(part), provenance },
            });
            continue;
        }
        if (item.kind === "relation_phrase") {
            const { startMs, endMs, ...rest } = item.payload;
            const part = mailRangeAt(parts, startMs, endMs);
            if (!part) continue;
            candidates.push({
                kind: "relation_phrase",
                fingerprint: item.fingerprint,
                preTicked: false,
                ...(item.dependsOnLabel
                    ? { dependsOnLabel: item.dependsOnLabel }
                    : {}),
                payload: {
                    ...rest,
                    text: anchorOf(part),
                    provenance: provenanceOf(part, participants),
                },
            });
        }
    }
    return candidates;
}
