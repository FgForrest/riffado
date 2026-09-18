"use client";

import { Check, Clipboard, Download, Loader2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { SidecarKind } from "@/lib/export/document-sidecars";

interface MarkdownActionsProps {
    kind: SidecarKind;
    recordingId: string;
    source: string;
}

export function MarkdownActions({
    kind,
    recordingId,
    source,
}: MarkdownActionsProps) {
    const i18n = useExtracted();
    const [copyState, setCopyState] = useState<"idle" | "copying" | "copied">(
        "idle",
    );
    const endpoint = `/api/recordings/${encodeURIComponent(recordingId)}/markdown/${kind}?source=${encodeURIComponent(source)}`;
    const documentLabel =
        kind === "transcript" ? i18n("transcript") : i18n("summary");

    const copyMarkdown = async () => {
        setCopyState("copying");
        try {
            const response = await fetch(endpoint, { cache: "no-store" });
            if (!response.ok) throw new Error("Markdown download failed");
            await navigator.clipboard.writeText(await response.text());
            setCopyState("copied");
            toast.success(
                kind === "transcript"
                    ? i18n("Transcript Markdown copied")
                    : i18n("Summary Markdown copied"),
            );
            window.setTimeout(() => setCopyState("idle"), 1500);
        } catch {
            setCopyState("idle");
            toast.error(
                i18n("Failed to copy {document} Markdown", {
                    document: documentLabel,
                }),
            );
        }
    };

    return (
        <div className="flex items-center gap-1">
            <Button asChild size="icon-sm" variant="ghost">
                <a
                    href={endpoint}
                    aria-label={i18n("Download {document} Markdown", {
                        document: documentLabel,
                    })}
                    title={i18n("Download {document} Markdown", {
                        document: documentLabel,
                    })}
                >
                    <Download className="size-4" />
                </a>
            </Button>
            <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={copyMarkdown}
                disabled={copyState === "copying"}
                aria-label={i18n("Copy {document} Markdown", {
                    document: documentLabel,
                })}
                title={i18n("Copy {document} Markdown", {
                    document: documentLabel,
                })}
            >
                {copyState === "copying" ? (
                    <Loader2 className="size-4 animate-spin" />
                ) : copyState === "copied" ? (
                    <Check className="size-4" />
                ) : (
                    <Clipboard className="size-4" />
                )}
            </Button>
        </div>
    );
}
