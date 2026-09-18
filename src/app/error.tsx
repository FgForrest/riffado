"use client";

import { useExtracted } from "next-intl";
import posthog from "posthog-js";
import { useEffect } from "react";
import { MetalButton } from "@/components/metal-button";

/**
 * App Router error boundary. Catches render errors that `capture_exceptions`
 * autocapture misses (React error boundaries don't propagate to
 * `window.onerror`). No-ops when PostHog isn't initialized (self-host).
 */
export default function ErrorBoundary({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const i18n = useExtracted();
    useEffect(() => {
        if (posthog.__loaded) {
            posthog.captureException(error);
        }
    }, [error]);

    return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
            <h2 className="text-lg font-medium">
                {i18n("Something went wrong")}
            </h2>
            <p className="text-sm text-muted-foreground">
                {i18n("Try again, or reload the page if it keeps happening.")}
            </p>
            <MetalButton onClick={() => reset()}>
                {i18n("Try again")}
            </MetalButton>
        </div>
    );
}
