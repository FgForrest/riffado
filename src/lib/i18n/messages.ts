import csCzMessages from "../../../messages/cs-CZ.json";
import enMessages from "../../../messages/en.json";
import type { AppLocale } from "./config";

export function messagesForLocale(locale: AppLocale) {
    return locale === "cs-CZ" ? csCzMessages : enMessages;
}

export function translatedSourceMessage(
    locale: AppLocale,
    sourceMessage: string,
): string {
    const entry = Object.entries(enMessages).find(
        ([, message]) => message === sourceMessage,
    );
    if (!entry) return sourceMessage;
    const translated =
        messagesForLocale(locale)[entry[0] as keyof typeof enMessages];
    return typeof translated === "string" && translated.length > 0
        ? translated
        : sourceMessage;
}
