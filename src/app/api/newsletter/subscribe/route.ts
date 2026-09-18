import { NextResponse } from "next/server";
import React from "react";
import { z } from "zod";
import { upsertSubscriber } from "@/db/queries/newsletter-subscriptions";
import {
    htmlToText,
    resolveFromAddress,
    SmtpNotConfiguredError,
    sendEmailWithHeaders,
} from "@/lib/email/transport";
import { signUnsubscribeToken } from "@/lib/email/unsubscribe-token";
import { env } from "@/lib/env";
import { apiHandler } from "@/lib/errors";
import { localeFromAcceptLanguage, normalizeLocale } from "@/lib/i18n/config";
import { createEmailTranslator } from "@/lib/i18n/email-messages";
import { NewsletterConfirmEmail } from "@/lib/notifications/email-templates/newsletter-confirm-email";
import { renderEmailHtml } from "@/lib/notifications/render-email";
import { consumeRateLimitBucket, getClientIp } from "@/lib/rate-limit";

const subscribeSchema = z.object({
    email: z.string().email().max(320),
    company: z.string().optional(),
    source: z
        .union([z.literal("landing"), z.literal("install"), z.literal("admin")])
        .optional(),
    locale: z.enum(["en", "cs-CZ"]).optional(),
});

export const POST = apiHandler(async (req: Request) => {
    const requestLocale = localeFromAcceptLanguage(
        req.headers.get("accept-language"),
    );
    const requestMessages = createEmailTranslator(requestLocale);
    const ip = getClientIp(req);
    const limit = await consumeRateLimitBucket(`newsletter:subscribe:${ip}`, {
        limit: 5,
        windowMs: 60_000,
    });
    if (!limit.allowed) {
        return NextResponse.json(
            { error: requestMessages("newsletterRateLimit") },
            { status: 429 },
        );
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json(
            { error: requestMessages("newsletterInvalidBody") },
            { status: 400 },
        );
    }

    const parsed = subscribeSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: requestMessages("newsletterInvalidInput") },
            { status: 400 },
        );
    }

    if (parsed.data.company && parsed.data.company.trim() !== "") {
        return NextResponse.json({ ok: true });
    }

    const locale = normalizeLocale(parsed.data.locale) ?? requestLocale;
    const subscriber = await upsertSubscriber({
        email: parsed.data.email,
        source: parsed.data.source ?? "landing",
        locale,
    });

    if (subscriber.confirmedAt) {
        return NextResponse.json({ ok: true });
    }

    try {
        await sendConfirmation(
            subscriber.id,
            subscriber.email,
            subscriber.locale,
        );
    } catch (error) {
        if (error instanceof SmtpNotConfiguredError) {
            // Expected on self-host instances without SMTP configured --
            // the subscriber row still exists and will get their
            // confirmation email once SMTP is set up. Not a failure.
            console.warn(
                "[newsletter] SMTP not configured; confirmation email skipped",
            );
            return NextResponse.json({ ok: true });
        }
        // Any other failure (render exception, transient SMTP error) means
        // the user will never see a confirm link. Surface it as a 5xx
        // instead of silently returning ok:true so the client can show an
        // error and the user knows to retry.
        console.error("[newsletter] failed to send confirmation email", error);
        return NextResponse.json(
            {
                error: createEmailTranslator(locale)("newsletterSendFailed"),
            },
            { status: 502 },
        );
    }

    return NextResponse.json({ ok: true });
});

async function sendConfirmation(
    subscriberId: string,
    email: string,
    locale: "en" | "cs-CZ",
): Promise<void> {
    const base = env.APP_URL?.replace(/\/$/, "");
    if (!base) {
        throw new Error(
            "newsletter/subscribe: APP_URL is not configured; cannot build confirmation URL",
        );
    }
    const token = signUnsubscribeToken("subscriber", subscriberId);
    const confirmUrl = `${base}/api/newsletter/confirm?s=${encodeURIComponent(subscriberId)}&t=${encodeURIComponent(token)}`;

    const html = await renderEmailHtml(
        React.createElement(NewsletterConfirmEmail, { confirmUrl }),
        locale,
    );

    await sendEmailWithHeaders({
        to: email,
        from: resolveFromAddress("transactional"),
        subject: createEmailTranslator(locale)("newsletterConfirm"),
        html,
        text: htmlToText(html),
    });
}
