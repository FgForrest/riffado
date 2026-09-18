import { createTranslator } from "use-intl/core";
import csCzMessages from "../../../messages/email/cs-CZ.json";
import enMessages from "../../../messages/email/en.json";
import type { AppLocale } from "./config";

export function createEmailTranslator(locale: AppLocale) {
    return createTranslator({
        locale,
        messages: locale === "cs-CZ" ? csCzMessages : enMessages,
    });
}
