import {
    deleteMailContent,
    deleteMailSummaries,
    type MailReapCandidate,
    type MailRetentionKind,
    type MailRetentionPolicy,
    reapRawMailMessage,
} from "@/db/queries/mail-retention";
import type { RetentionGovernor } from "@/db/queries/retention";
import { deleteRawMail } from "@/lib/mail/raw-storage";

export interface MailReapOutcome {
    reaped: MailRetentionKind[];
    /** Kind -> operational error. The other parts still run. */
    failed: Partial<Record<MailRetentionKind, unknown>>;
}

function isDue(receivedAt: Date, days: number | null, now: Date): boolean {
    return (
        days !== null &&
        receivedAt.getTime() < now.getTime() - days * 24 * 60 * 60 * 1000
    );
}

/**
 * Remove the parts of one aged mail this policy selects. The mail stays in
 * the pile with who wrote it to whom, marked with what went. A folder
 * export keeps the message it wrote, as it keeps reaped audio. A shared
 * mail is the Organization's policy's: each part is checked again under
 * the mail's lock, so a share or withdrawal since the sweep chose it wins.
 */
export async function reapMail(
    policy: MailRetentionPolicy,
    mail: MailReapCandidate,
    now = new Date(),
    orgUserId: string | null = null,
): Promise<MailReapOutcome> {
    const governor: RetentionGovernor = policy.isOrg
        ? { isOrg: true, orgUserId: policy.userId }
        : { isOrg: false, orgUserId };
    const reaped: MailRetentionKind[] = [];
    const failed: Partial<Record<MailRetentionKind, unknown>> = {};
    const attempt = async (
        kind: MailRetentionKind,
        run: () => Promise<boolean>,
    ) => {
        try {
            if (await run()) reaped.push(kind);
        } catch (error) {
            failed[kind] = error;
        }
    };

    if (isDue(mail.receivedAt, policy.rawDays, now) && mail.rawStoragePath) {
        await attempt("raw", () =>
            reapRawMailMessage(mail.id, mail.userId, governor, now, (key) =>
                deleteRawMail(mail.userId, key),
            ),
        );
    }
    if (
        isDue(mail.receivedAt, policy.contentDays, now) &&
        mail.contentReapedAt === null
    ) {
        await attempt("content", () =>
            deleteMailContent(mail.id, mail.userId, governor, now),
        );
    }
    if (
        isDue(mail.receivedAt, policy.summaryDays, now) &&
        mail.summaryReapedAt === null
    ) {
        await attempt(
            "summary",
            async () =>
                (await deleteMailSummaries(
                    mail.id,
                    mail.userId,
                    governor,
                    now,
                )) > 0,
        );
    }
    return { reaped, failed };
}
