import { AsyncLocalStorage } from "node:async_hooks";
import type { TranslationValues } from "use-intl/core";
import { type AppLocale, defaultLocale } from "@/lib/i18n/config";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import "./email-template-catalog";

const emailLocale = new AsyncLocalStorage<AppLocale>();

/** Runs one email render with its recipient locale isolated from other renders. */
export function runWithEmailLocale<Result>(
    locale: AppLocale,
    render: () => Result,
): Result {
    return emailLocale.run(locale, render);
}

/** Returns the locale selected for the current email render. */
export function getEmailLocale(): AppLocale {
    return emailLocale.getStore() ?? defaultLocale;
}

/** Returns a source-message translator for the current email render. */
export function getEmailTranslator() {
    const locale = getEmailLocale();
    return (sourceMessage: string, values?: TranslationValues) =>
        translatedSourceMessage(locale, sourceMessage, values);
}
