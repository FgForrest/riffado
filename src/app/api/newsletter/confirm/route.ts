import { type NextRequest, NextResponse } from "next/server";
import {
    confirmSubscriber,
    getSubscriberById,
} from "@/db/queries/newsletter-subscriptions";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribe-token";
import {
    type AppLocale,
    localeFromAcceptLanguage,
    normalizeLocale,
} from "@/lib/i18n/config";
import { createEmailTranslator } from "@/lib/i18n/email-messages";

/**
 * Renders a confirm page requiring a user-initiated POST rather than
 * confirming on GET. Automated link scanners (email security gateways,
 * link-preview bots) follow GET links from inboxes before the user ever
 * sees the email; a GET that mutates state would let a scanner complete
 * double opt-in without the user's action.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
    const requestLocale = localeFromAcceptLanguage(
        req.headers.get("accept-language"),
    );
    const params = req.nextUrl.searchParams;
    const id = params.get("s");
    const token = params.get("t");

    if (!id || !token) return badRequest(requestLocale);
    if (!verifyUnsubscribeToken("subscriber", id, token)) {
        return badRequest(requestLocale);
    }

    const subscriber = await getSubscriberById(id);
    if (!subscriber) return badRequest(requestLocale);

    return confirmPage(
        id,
        token,
        normalizeLocale(subscriber.locale) ?? requestLocale,
    );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    const requestLocale = localeFromAcceptLanguage(
        req.headers.get("accept-language"),
    );
    const form = await req.formData().catch(() => null);
    const id = form?.get("s");
    const token = form?.get("t");

    if (typeof id !== "string" || typeof token !== "string") {
        return badRequest(requestLocale);
    }
    if (!verifyUnsubscribeToken("subscriber", id, token)) {
        return badRequest(requestLocale);
    }

    const subscriber = await getSubscriberById(id);
    if (!subscriber) return badRequest(requestLocale);

    await confirmSubscriber(id);
    return successPage(normalizeLocale(subscriber.locale) ?? requestLocale);
}

function badRequest(locale: AppLocale): NextResponse {
    const t = createEmailTranslator(locale);
    return new NextResponse(
        renderPage({
            locale,
            title: t("newsletterInvalidTitle"),
            body: `<p>${escapeHtml(t("newsletterInvalidPageBody"))}</p><p>${escapeHtml(t("newsletterSubscribeAgain"))} <a href="/updates">riffado.com/updates</a>.</p>`,
        }),
        {
            status: 400,
            headers: { "content-type": "text/html; charset=utf-8" },
        },
    );
}

function confirmPage(
    id: string,
    token: string,
    locale: AppLocale,
): NextResponse {
    const t = createEmailTranslator(locale);
    return new NextResponse(
        renderPage({
            locale,
            title: t("newsletterConfirmPageTitle"),
            body: `
                <p>${escapeHtml(t("newsletterConfirmPageBody"))}</p>
                <form method="post" action="/api/newsletter/confirm">
                    <input type="hidden" name="s" value="${escapeHtml(id)}" />
                    <input type="hidden" name="t" value="${escapeHtml(token)}" />
                    <button type="submit" style="font: inherit; padding: 0.6rem 1.2rem; border-radius: 0.4rem; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer;">${escapeHtml(t("newsletterConfirmPageButton"))}</button>
                </form>
            `,
        }),
        {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
        },
    );
}

function successPage(locale: AppLocale): NextResponse {
    const t = createEmailTranslator(locale);
    return new NextResponse(
        renderPage({
            locale,
            title: t("newsletterConfirmedTitle"),
            body: `
                <p>${escapeHtml(t("newsletterConfirmedBody"))}</p>
                <p>${escapeHtml(t("newsletterConfirmedFooter"))}</p>
            `,
        }),
        {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
        },
    );
}

function renderPage({
    locale,
    title,
    body,
}: {
    locale: AppLocale;
    title: string;
    body: string;
}): string {
    return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)} -- Riffado</title>
  <meta name="robots" content="noindex" />
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 36rem; margin: 6rem auto; padding: 0 1.5rem; line-height: 1.55; color: #111; background: #fafafa; }
    @media (prefers-color-scheme: dark) { body { color: #e7e7e7; background: #0a0a0a; } a { color: #8ab4ff; } }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    p { margin: 0 0 1rem; }
    a { color: inherit; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${body}
</body>
</html>`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
