import { db } from "@/db";
import { mailAddresses } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { backfillMailAddresses, resolveLocalPart } from "@/lib/mail/addresses";
import { isMailEnabled } from "@/lib/mail/config";

/**
 * Startup hook: while mail is on, give every eligible user a mailbox and
 * every custom folder an address they lack, then confirm an address still
 * resolves under the current hash key. In the background: nothing waits.
 */
export function startMail(): void {
    if (!isMailEnabled()) return;
    void (async () => {
        try {
            const counts = await backfillMailAddresses();
            if (counts.mailboxes > 0 || counts.folders > 0) {
                console.log(
                    `[mail] assigned ${counts.mailboxes} mailbox(es) and ${counts.folders} folder address(es)`,
                );
            }
            await selfCheck();
        } catch (error) {
            console.error("[mail] address backfill failed:", error);
        }
    })();
}

/**
 * A known address resolves through its stored hash: a changed
 * MAIL_ADDRESS_HASH_SECRET would silently unhook every address.
 */
async function selfCheck(): Promise<void> {
    const [sample] = await db
        .select({ localPart: mailAddresses.localPart })
        .from(mailAddresses)
        .limit(1);
    if (!sample) return;
    const resolved = await resolveLocalPart(decryptText(sample.localPart));
    if (!resolved) {
        console.error(
            "[mail] stored addresses do not resolve: MAIL_ADDRESS_HASH_SECRET changed? Mail to existing addresses is refused until it is restored.",
        );
    }
}
