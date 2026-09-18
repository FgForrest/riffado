"use client";

import posthog from "posthog-js";
import { useEffect, useState } from "react";
import { defaultLocale, normalizeLocale } from "@/lib/i18n/config";
import { translatedSourceMessage } from "@/lib/i18n/messages";

/**
 * Root-layout-level error boundary -- catches errors that occur in
 * `layout.tsx` itself, where the regular `error.tsx` boundary can't help
 * because it renders inside the layout it would need to replace. Must
 * render its own <html>/<body>; Next.js swaps the whole document in.
 */
export default function GlobalError({
    error,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const [locale, setLocale] = useState(defaultLocale);
    useEffect(() => {
        setLocale(normalizeLocale(navigator.language) ?? defaultLocale);
        if (posthog.__loaded) {
            posthog.captureException(error);
        }
    }, [error]);

    return (
        <html lang={locale}>
            <body>
                <div
                    style={{
                        display: "flex",
                        minHeight: "100vh",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "1rem",
                        padding: "1rem",
                        textAlign: "center",
                        fontFamily: "system-ui, sans-serif",
                    }}
                >
                    <h2>
                        {translatedSourceMessage(
                            locale,
                            "Something went wrong",
                        )}
                    </h2>
                    <p>
                        {translatedSourceMessage(
                            locale,
                            "Try again, or reload the page if it keeps happening.",
                        )}
                    </p>
                </div>
            </body>
        </html>
    );
}
