import type {
    ContentParticipant,
    ContentSegment,
    ItemContent,
} from "@/lib/content/types";

/** What a model is told about a mail beside its content. */
export interface MailHeaderFacts {
    subject: string;
    sentAt: Date | null;
}

function domainOf(address: string | null | undefined): string | null {
    if (!address) return null;
    const at = address.lastIndexOf("@");
    return at > 0 ? address.slice(at + 1).toLowerCase() : null;
}

function describe(participant: ContentParticipant): string {
    const facts = [
        participant.roles.join(", ") || "mentioned",
        domainOf(participant.address),
        participant.authenticated ? "verified" : null,
    ].filter(Boolean);
    const name = participant.displayName?.trim();
    return `- ${participant.ref}: ${name || "(no name)"} (${facts.join("; ")})`;
}

function label(segment: ContentSegment): string {
    const parts = [`#${segment.index}`, segment.role.replace("_", " ")];
    if (segment.participantRef) parts.push(segment.participantRef);
    if (segment.depth > 0 && segment.at) {
        parts.push(`written ${segment.at.toISOString().slice(0, 10)}`);
    }
    return `[${parts.join(" ")}]`;
}

/**
 * A mail as a model reads it: subject, date, the participants by their
 * `pN` references with name, role and domain (never the full address), and
 * each segment under a `[#index role pN]` label that answers can point
 * back to. Parts repeating an item already in the pile are left out.
 */
export function renderMailForModel(
    content: Pick<ItemContent, "participants" | "segments">,
    facts: MailHeaderFacts,
): string {
    const lines = [
        `Subject: ${facts.subject.trim() || "(no subject)"}`,
        `Date: ${facts.sentAt ? facts.sentAt.toISOString() : "unknown"}`,
        "Participants:",
        ...content.participants.map(describe),
        "",
        "Message:",
    ];
    for (const segment of content.segments) {
        if (segment.knownItemId) continue;
        const text = segment.text.trim();
        if (!text) continue;
        lines.push(label(segment), text, "");
    }
    return lines.join("\n").trimEnd();
}
