import { createTranslator, type TranslationValues } from "use-intl/core";
import csCzMessages from "../../../messages/cs-CZ.json";
import enMessages from "../../../messages/en.json";
import type { AppLocale } from "./config";

const messageIdBySource = new Map(
    Object.entries(enMessages).map(([id, message]) => [message, id]),
);

const sourceTranslators = {
    en: createTranslator({
        locale: "en",
        messages: enMessages as Record<string, string>,
        timeZone: "UTC",
    }),
    "cs-CZ": createTranslator({
        locale: "cs-CZ",
        messages: csCzMessages as Record<string, string>,
        timeZone: "UTC",
    }),
};

export function messagesForLocale(locale: AppLocale) {
    return locale === "cs-CZ" ? csCzMessages : enMessages;
}

export function translatedSourceMessage(
    locale: AppLocale,
    sourceMessage: string,
    values?: TranslationValues,
): string {
    const messageId = messageIdBySource.get(sourceMessage);
    if (messageId) return sourceTranslators[locale](messageId, values);

    const fallback = createTranslator({
        locale,
        messages: { fallback: sourceMessage },
        timeZone: "UTC",
    });
    return fallback("fallback", values);
}
