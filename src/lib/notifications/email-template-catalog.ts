import { getExtracted } from "next-intl/server";

/** Keeps server-rendered email copy in next-intl's extracted catalogs. */
export async function extractEmailTemplateMessages(): Promise<void> {
    const i18n = await getExtracted();
    i18n("{version} available", { version: "" });
    i18n("Riffado. Your recordings, your transcripts.");
    i18n("Your Riffado account has been deleted.");
    i18n("Account deleted.");
    i18n(
        "Your Riffado account, recordings, transcripts, and summaries have been permanently deleted. We don't keep backups of deleted user data, so this is irreversible.",
    );
    i18n("Thanks for trying Riffado. If you change your mind, you can always");
    i18n("start fresh");
    i18n("or self-host the open-source version at");
    i18n("Confirm the email change on your Riffado account.");
    i18n("Confirm email change.");
    i18n(
        "A change request was made to update the email on your Riffado account to {newEmail}. Click below to confirm. The link expires in {hours, plural, one {# hour} other {# hours}}.",
        { newEmail: "", hours: 1 },
    );
    i18n("Confirm new email");
    i18n(
        "If you did not request this change, ignore this message and consider rotating your password.",
    );
    i18n("Your Riffado data export is ready to download.");
    i18n("Download export");
    i18n("Your export is ready");
    i18n(
        "We finished building your full data archive: every recording's audio, transcript, and AI summary, zipped up and ready to download.",
    );
    i18n("The download link stays active for 7 days.");
    i18n("Last chance: your Riffado account is deleted in under 24 hours.");
    i18n("Reactivate account");
    i18n("Last chance to export.");
    i18n("Your Riffado account is scheduled for permanent deletion on");
    i18n(
        ". That's under 24 hours from now. Every recording, transcript, and summary will be removed and cannot be recovered.",
    );
    i18n("Export now");
    i18n("Want to keep your account?");
    i18n("Add a card to reactivate");
    i18n(". Reactivation is instant, with no data loss.");
    i18n(
        "{days, plural, one {# day} other {# days}} left to export your Riffado data before the account is deleted.",
        { days: 1 },
    );
    i18n("{days, plural, one {# day} other {# days}} left to export.", {
        days: 1,
    });
    i18n(
        "A reminder: your Riffado account and every recording in it will be permanently deleted on",
    );
    i18n(
        ". You have {days, plural, one {# day} other {# days}} to export the data or reactivate.",
        { days: 1 },
    );
    i18n("Or");
    i18n("add a card to reactivate");
    i18n("and pick up where you left off.");
    i18n(
        "Your {trialDays}-day Riffado Pro trial ended without a card on file. You have {graceDays, plural, one {# day} other {# days}} to export your data; after that, your account and all recordings will be permanently deleted on {deletionDate}.",
        { trialDays: "1", graceDays: 1, deletionDate: "" },
    );
    i18n(
        "Your Riffado Pro subscription ended. You have {graceDays, plural, one {# day} other {# days}} to export your data or reactivate. After {deletionDate} your account and all recordings will be permanently deleted.",
        { graceDays: 1, deletionDate: "" },
    );
    i18n(
        "You have {days, plural, one {# day} other {# days}} to export your Riffado data before the account is deleted.",
        { days: 1 },
    );
    i18n(
        "Until then, your recordings are still playable and your data is fully exportable. Sync from your device and new transcriptions are paused.",
    );
    i18n("Changed your mind?");
    i18n(". Everything resumes instantly, and nothing is lost.");
    i18n(
        "Questions, or something looks off? Reply to this email. I read every one.",
    );
    i18n("Kacper, Riffado");
    i18n(
        "{count, plural, one {New recording synced} other {# new recordings synced}}",
        { count: 1 },
    );
    i18n("Manage notifications");
    i18n(
        "Your Plaud device synced the following {count, plural, one {recording} other {recordings}}:",
        { count: 1 },
    );
    i18n("+{count} more", { count: "1" });
    i18n(
        "Your Plaud device synced {count, plural, one {a new recording} other {# new recordings}} to your dashboard.",
        { count: 1 },
    );
    i18n("View recordings");
    i18n("Confirm your Riffado newsletter subscription");
    i18n("Confirm your subscription");
    i18n(
        "You asked to receive Riffado product updates. Click the button below to confirm. If you didn't sign up, ignore this email -- without confirmation we'll never email this address again.",
    );
    i18n("Confirm subscription");
    i18n("If the button doesn't work, paste this URL into your browser:");
    i18n(
        "Your Riffado account is over the Free storage limit. Sync of new objects is paused until you upgrade or free up space.",
    );
    i18n("You're over the Free cap.");
    i18n("Your account is using");
    i18n("of the");
    i18n("Free-tier storage cap.");
    i18n(
        "Your data is safe and your existing recordings still play. We've paused sync of",
    );
    i18n("new");
    i18n(
        "objects from Plaud until you either upgrade to Pro (50 GB cap) or delete enough recordings to come back under the limit.",
    );
    i18n("Reset your Riffado password");
    i18n("Reset your password");
    i18n(
        "We received a request to reset the password for your Riffado account. Click the button below to choose a new password. This link expires in 1 hour.",
    );
    i18n(
        "If you didn't request a password reset, you can safely ignore this email -- your password will not change.",
    );
    i18n(
        "Your Riffado Pro payment couldn't be processed. Update your payment method to keep Pro active.",
    );
    i18n("Update payment method");
    i18n("Payment failed.");
    i18n(
        "We couldn't process this cycle's charge for your Riffado Pro subscription. This usually means the card was declined or the bank flagged the transaction.",
    );
    i18n("Stripe will retry automatically");
    i18n("on {date}", { date: "" });
    i18n("shortly");
    i18n(
        " Your Pro access continues until {date}; after that the account drops to Free.",
        { date: "" },
    );
    i18n(
        " Your Pro access continues for now; if retries keep failing the account drops to Free.",
    );
    i18n("Hey {name},", { name: "" });
    i18n("Hey,");
    i18n("OpenPlaud is now Riffado. Same code, same team, new name.");
    i18n("Unsubscribe from product updates");
    i18n(
        "Quick note: the project you signed up for as OpenPlaud is now called Riffado. Same code, same team, same AGPL license. We changed the name because the roadmap is broader than one recorder, and the old name kept boxing us in. That's it.",
    );
    i18n(
        "Nothing about your account changes. Your recordings, transcripts, summaries, and settings are exactly where you left them. Same prices, same free tier, same self-host install. Your API tokens (the ones starting with",
    );
    i18n(
        ") keep working -- nothing to rotate in n8n, Zapier, or any of your scripts.",
    );
    i18n("The main practical change: the URL is");
    i18n("riffado.com");
    i18n(
        "now. The old domain redirects automatically, but update your bookmarks when you get a chance.",
    );
    i18n(
        "Full story (not a buyout, not an acquisition, not a fork) and the details for self-hosters live at",
    );
    i18n("riffado.com/rebrand");
    i18n("If anything broke for you, hit reply. I read this inbox.");
    i18n("Kacper, from Riffado");
    i18n(
        "You're receiving this because you have a Riffado (formerly OpenPlaud) account. This is a one-time announcement about the rebrand. You'll still receive transactional email: password resets, sync notifications, and the like.",
    );
    i18n("Test email from Riffado - Email notifications are working");
    i18n("Test email");
    i18n(
        "Your email notifications are configured correctly. You'll receive an email when new recordings are synced from your Plaud device.",
    );
    i18n("Open dashboard");
    i18n(
        "Your hosted account is now read-only. Your data is safe, and you can subscribe anytime to resume.",
    );
    i18n("Manage billing");
    i18n(
        "Your account is now read-only. Your recordings, transcripts, and summaries are all still here and fully exportable, but sync, uploads, and new transcriptions are paused until you subscribe.",
    );
    i18n(
        "Nothing will be deleted. Pick this back up whenever you're ready. Subscribe and everything resumes instantly at",
    );
    i18n("Subscribe and resume");
    i18n("Want to keep Riffado free? You can");
    i18n("self-host");
    i18n("the open-source version and bring your data with you. You can");
    i18n("export everything here");
    i18n(
        "{days, plural, one {# day} other {# days}} of free Hosted Pro left. Choose a plan to keep sync and transcription.",
        { days: 1 },
    );
    i18n(
        "{days, plural, one {# day} other {# days}} of free Hosted Pro left.",
        { days: 1 },
    );
    i18n("Your free hosted window closes on");
    i18n(
        ". To keep background sync, new transcriptions, and uploads running, choose a plan before then.",
    );
    i18n("Founding monthly spots are still available to the first");
    i18n("paid monthly members at");
    i18n(
        ". Once claimed, that price stays locked while the subscription remains active.",
    );
    i18n("Monthly Hosted Pro is currently");
    i18n("Lock in {price}", { price: "" });
    i18n(
        "If you'd rather not subscribe, that's fine. Nothing gets deleted. After",
    );
    i18n(
        "your account goes read-only: your recordings stay playable and exportable, but sync and new transcriptions pause until you subscribe. You can",
    );
    i18n("self-host for free");
    i18n("export everything");
    i18n("whenever you want.");
    i18n("&bull;");
    i18n(
        "Hosted Pro is live. The essentials are at the top; the story's below. Nothing changes until {deadline}.",
        { deadline: "" },
    );
    i18n("Hosted Pro is here.");
    i18n("In short");
    i18n("You keep full free access until");
    i18n(". Nothing changes today.");
    i18n("After that, Hosted Pro is");
    i18n(", locked in for as long as you stay subscribed, for the first");
    i18n("paid monthly members (first-paid, first-served).");
    i18n(
        "If you don't act, your account goes read-only. Nothing gets deleted.",
    );
    i18n("Self-hosting stays free forever. That's not changing.");
    i18n("Here's the story behind that, if you want it.");
    i18n(
        "Riffado started as a simple idea: your recordings and transcripts should belong to you, and you should choose which AI touches them. That part worked. But hosted Riffado runs on real infrastructure: servers, storage for your audio, and the compute behind Mynah, the transcription service included with Hosted Pro. Free hosting was the right call for an early cohort helping us find the rough edges. Thank you for that. It's not something we can run forever on goodwill, so Hosted Pro is now a paid plan.",
    );
    i18n(
        "A subscription is the most honest way to fund this: no ads, no selling your data, no lock-in. And because Riffado is one AGPL codebase, everything a Hosted Pro subscription funds ships to self-hosters too. Paying for Hosted Pro pays for the project, not just your own account.",
    );
    i18n(
        "That also means self-hosting isn't going anywhere. The source stays AGPL-3.0, and the exact code running Hosted is the code you can",
    );
    i18n("run yourself");
    i18n(
        ": your machine, your storage, free forever. Self-host and Hosted Pro are the same project, run two different ways.",
    );
    i18n(
        "Hosted Pro includes 50 GB of storage, 15 hours of Mynah transcription every month, unlimited devices, and background sync that keeps pulling recordings even when your browser is closed. Bring your own AI key if you'd rather (OpenAI, Groq, anything compatible); Riffado adds no markup when you do.",
    );
    i18n("What this means for your account");
    i18n("Your access stays free until");
    i18n("As an early user, you can lock in the founding price of");
    i18n(", limited to the first");
    i18n("paid monthly members, first-paid, first-served.");
    i18n("Monthly Hosted Pro is available for");
    i18n(
        "You can cancel anytime. Canceling starts a grace period, so nothing is lost immediately even then.",
    );
    i18n("Claim founding price");
    i18n("Choose a plan");
    i18n("If you don't choose a plan by");
    i18n(
        ", your account becomes read-only. Nothing gets deleted: every recording, transcript, and summary stays playable and exportable. Sync, uploads, and new transcriptions pause until you subscribe,",
    );
    i18n("export");
    i18n(", or self-host.");
    i18n(
        "Questions, or something looks off? Reply. It comes straight to me, and I read this inbox.",
    );
    i18n("Kacper, building Riffado");
    i18n(
        "Confirm your email address to finish setting up your Riffado account.",
    );
    i18n("Confirm your email.");
    i18n(
        "Click the button below to confirm this is your email address and finish setting up your Riffado account. The link expires in {hours, plural, one {# hour} other {# hours}}.",
        { hours: 1 },
    );
    i18n("Confirm email");
    i18n(
        "If you didn't sign up for Riffado, you can safely ignore this message.",
    );
    i18n(
        "You're on Riffado Hosted Pro: 50 GB storage, 15 hours of Mynah transcription, unlimited devices.",
    );
    i18n("You're on Hosted Pro.");
    i18n(
        "Thanks for upgrading. You've already synced {recordings, plural, one {# recording} other {# recordings}}{hours, plural, =0 {} one { (about # hour of audio)} other { (about # hours of audio)}}. Sync and transcription keep running without interruption, and your Pro entitlements are live:",
        { recordings: 1, hours: 1 },
    );
    i18n(
        "Thanks for upgrading. Your subscription is active and your Pro entitlements are live:",
    );
    i18n("• 50 GB storage");
    i18n("• 15 hours of Mynah transcription, refreshed every 30 days");
    i18n("• Unlimited devices, background sync");
    i18n("You're founding member #{rank} of {capacity}.", {
        rank: "1",
        capacity: "1",
    });
    i18n("You subscribed during the founding-member window.");
    i18n("Your monthly price is locked at");
    i18n(
        "for as long as your subscription stays active. Thanks for being early.",
    );
    i18n("Open Riffado");
    i18n(
        "\"Email support\" isn't a ticket queue here. Reply to this email if anything's off or you have a question. It reaches me directly.",
    );
}
