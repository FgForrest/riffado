import type {
    ContentParticipant,
    ContentSegment,
    ItemContent,
    ParticipantRole,
} from "@/lib/content/types";

/** A mail's stored content, decrypted. */
export interface MailContentSource {
    itemId: string;
    /** The `mail_contents` row. */
    contentId: string;
    revision: number;
    language: string | null;
    segments: readonly (Omit<ContentSegment, "at"> & {
        at: string | Date | null;
    })[];
    participants: readonly {
        ref: string;
        roles: readonly string[];
        name: string | null;
        address: string | null;
        authenticated: boolean;
        personId?: string | null;
    }[];
}

const ROLES: ReadonlySet<string> = new Set<ParticipantRole>([
    "from",
    "sender",
    "to",
    "cc",
    "reply_to",
    "quoted_author",
]);

/**
 * A mail's content as every kind's: its participants under their `pN`
 * references, and its segments in reading order. A quoted part that repeats
 * an item already in the pile stays, marked, for the reader to skip.
 */
export function mailContentFrom(source: MailContentSource): ItemContent {
    const participants: ContentParticipant[] = source.participants.map(
        (participant) => ({
            ref: participant.ref,
            roles: participant.roles.filter((role): role is ParticipantRole =>
                ROLES.has(role),
            ),
            displayName: participant.name,
            address: participant.address,
            authenticated: participant.authenticated,
            personId: participant.personId ?? null,
        }),
    );
    return {
        itemId: source.itemId,
        kind: "mail",
        sourceId: source.contentId,
        revision: source.revision,
        language: source.language,
        participants,
        segments: source.segments.map((segment) => ({
            ...segment,
            at: segment.at ? new Date(segment.at) : null,
        })),
    };
}
