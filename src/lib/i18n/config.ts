export const locales = ["en", "cs-CZ"] as const;

export type AppLocale = (typeof locales)[number];

export const defaultLocale: AppLocale = "en";

export function isSupportedLocale(value: unknown): value is AppLocale {
    return typeof value === "string" && locales.includes(value as AppLocale);
}

export function normalizeLocale(
    value: string | null | undefined,
): AppLocale | null {
    if (!value) return null;

    const normalized = value.trim().replaceAll("_", "-").toLowerCase();
    if (normalized === "cs" || normalized.startsWith("cs-")) return "cs-CZ";
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
    return null;
}

export function localeFromAcceptLanguage(value: string | null): AppLocale {
    if (!value) return defaultLocale;

    const candidates = value
        .split(",")
        .map((entry, index) => {
            const [tag = "", ...parameters] = entry.trim().split(";");
            const qualityParameter = parameters.find((parameter) =>
                parameter.trim().startsWith("q="),
            );
            const quality = qualityParameter
                ? Number.parseFloat(qualityParameter.trim().slice(2))
                : 1;
            return {
                index,
                locale: normalizeLocale(tag),
                quality: Number.isFinite(quality) ? quality : 0,
            };
        })
        .filter(
            (
                candidate,
            ): candidate is typeof candidate & { locale: AppLocale } =>
                candidate.locale !== null && candidate.quality > 0,
        )
        .sort(
            (left, right) =>
                right.quality - left.quality || left.index - right.index,
        );

    return candidates[0]?.locale ?? defaultLocale;
}
