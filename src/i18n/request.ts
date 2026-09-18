import { headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { getSession } from "@/lib/auth-server";
import { localeFromAcceptLanguage, normalizeLocale } from "@/lib/i18n/config";
import { messagesForLocale } from "@/lib/i18n/messages";

export default getRequestConfig(async () => {
    const [session, requestHeaders] = await Promise.all([
        getSession(),
        headers(),
    ]);
    const locale =
        normalizeLocale(session?.user.uiLocale) ??
        localeFromAcceptLanguage(requestHeaders.get("accept-language"));

    return {
        locale,
        messages: messagesForLocale(locale),
    };
});
