import {
    type SummarySidecarTask,
    summarySections,
} from "@/lib/export/document-sidecars";
import { loadMailDetail, type MailDetail } from "@/lib/mail/detail";
import { secretAddressMasker } from "@/lib/mail/redact";
import { readStoredSummary } from "@/lib/summary/read-summary";
import { tasksForArchive } from "@/lib/tasks/archive";

/** What a mail's Markdown document says beside the mail itself. */
export interface MailDocumentSummary {
    summary: string | null;
    keyPoints: string[];
    actionItems: string[];
    tasks: SummarySidecarTask[];
}

function yamlString(value: string): string {
    return JSON.stringify(value);
}

function person(participant: MailDetail["participants"][number]): string {
    const name = participant.name?.trim();
    const address = participant.address?.trim();
    if (name && address) return `${name} <${address}>`;
    return name || address || participant.ref;
}

function withRole(detail: MailDetail, role: string): string[] {
    return detail.participants
        .filter((participant) => participant.roles.includes(role))
        .map(person);
}

function quoteHeader(
    detail: MailDetail,
    segment: MailDetail["segments"][number],
): string | null {
    const author = segment.participantRef
        ? detail.participants.find(
              (participant) => participant.ref === segment.participantRef,
          )
        : undefined;
    const by = author ? person(author) : null;
    const at = segment.at?.slice(0, 10) ?? null;
    if (by && at) return `On ${at}, ${by} wrote:`;
    if (by) return `${by} wrote:`;
    if (at) return `On ${at}:`;
    return null;
}

function blockquote(text: string, depth: number): string {
    const marker = `${">".repeat(Math.max(1, depth))} `;
    return text
        .split("\n")
        .map((line) => `${marker}${line}`.trimEnd())
        .join("\n");
}

function sizeOf(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A mail as Markdown: its headers, its text part by part (quoted messages
 * as quotes under who wrote them), its attachments, and its summary and
 * tasks. Pure: the reader's masking is already in `detail`.
 */
export function buildMailMarkdown(
    detail: MailDetail,
    summary: MailDocumentSummary | null,
): string {
    const from = withRole(detail, "from");
    const to = withRole(detail, "to");
    const cc = withRole(detail, "cc");
    const list = (key: string, values: string[]) =>
        values.length === 0
            ? [`${key}: []`]
            : [`${key}:`, ...values.map((value) => `  - ${yamlString(value)}`)];
    const frontMatter = [
        "---",
        `title: ${yamlString(detail.subject)}`,
        `sent: ${detail.sentAt ?? "null"}`,
        `received: ${detail.receivedAt}`,
        ...list("from", from),
        ...list("to", to),
        ...list("cc", cc),
        `sender_verified: ${detail.senderVerified}`,
        "---",
    ].join("\n");

    const headers = [
        from.length > 0 ? `**From:** ${from.join(", ")}` : null,
        to.length > 0 ? `**To:** ${to.join(", ")}` : null,
        cc.length > 0 ? `**Cc:** ${cc.join(", ")}` : null,
        `**Date:** ${detail.sentAt ?? detail.receivedAt}`,
    ].filter((line): line is string => line !== null);

    const parts: string[] = [];
    for (const segment of detail.segments) {
        const text = segment.text.trim();
        if (!text) continue;
        if (segment.role === "quoted" || segment.role === "quoted_signature") {
            const header =
                segment.role === "quoted" ? quoteHeader(detail, segment) : null;
            parts.push(
                [header, blockquote(text, segment.depth)]
                    .filter(Boolean)
                    .join("\n\n"),
            );
        } else if (segment.role === "signature") {
            parts.push(`-- \n${text}`);
        } else {
            parts.push(text);
        }
    }
    if (parts.length === 0 && detail.unreadable) {
        parts.push("_The content of this mail could not be read._");
    }

    const sections = [
        `# ${detail.subject.trim() || "(no subject)"}`,
        headers.join("  \n"),
        ...parts,
    ];
    if (detail.attachments.length > 0) {
        sections.push(
            `## Attachments\n\n${detail.attachments
                .map(
                    (attachment) =>
                        `- ${attachment.filename ?? "(unnamed)"} (${attachment.contentType}, ${sizeOf(attachment.size)})`,
                )
                .join("\n")}`,
        );
    }
    if (summary) sections.push(...summarySections(summary));
    return `${frontMatter}\n\n${sections.join("\n\n")}\n`;
}

/**
 * The Markdown document of the mail `itemId` (of `ownerUserId`) as the
 * export of `viewerUserId` writes it: the owner's in full, the
 * Organization's with secret addresses masked, as the mail reads to them.
 * Rendered when planned and written, never stored. Null when the viewer
 * may not read it.
 */
export async function mailMarkdownDocument({
    viewerUserId,
    ownerUserId,
    itemId,
}: {
    viewerUserId: string;
    ownerUserId: string;
    itemId: string;
}): Promise<string | null> {
    const detail = await loadMailDetail(viewerUserId, itemId);
    if (!detail) return null;
    const [stored, tasks] = await Promise.all([
        readStoredSummary(ownerUserId, itemId),
        tasksForArchive(
            // The owner's own export: the tasks not the Organization's to add.
            detail.isOwn
                ? { kind: "personal", userId: ownerUserId }
                : { kind: "owner", userId: ownerUserId },
            [itemId],
        ),
    ]);
    const kept = (tasks.get(itemId) ?? [])
        .filter((task) => task.status !== "dropped")
        .map((task) => ({
            text: task.text,
            done: task.status === "done",
            assignee: task.assignee?.name ?? task.assigneeHint,
            dueDate: task.dueDate,
        }));
    const summary =
        stored || kept.length > 0
            ? {
                  summary: stored?.summary ?? null,
                  keyPoints: stored?.keyPoints ?? [],
                  actionItems: stored?.actionItems ?? [],
                  tasks: kept,
              }
            : null;
    if (!summary || detail.isOwn) return buildMailMarkdown(detail, summary);
    const mask = await secretAddressMasker([
        summary.summary ?? "",
        ...summary.keyPoints,
        ...summary.actionItems,
        ...summary.tasks.flatMap((task) => [task.text, task.assignee ?? ""]),
    ]);
    return buildMailMarkdown(detail, {
        summary: summary.summary ? mask(summary.summary) : null,
        keyPoints: summary.keyPoints.map(mask),
        actionItems: summary.actionItems.map(mask),
        tasks: summary.tasks.map((task) => ({
            ...task,
            text: mask(task.text),
            assignee: task.assignee ? mask(task.assignee) : null,
        })),
    });
}
