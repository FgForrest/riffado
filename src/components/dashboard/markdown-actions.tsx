"use client";

import { Check, Clipboard, Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { SidecarKind } from "@/lib/export/document-sidecars";

interface MarkdownActionsProps {
    kind: SidecarKind;
    recordingId: string;
}

export function MarkdownActions({ kind, recordingId }: MarkdownActionsProps) {
    const [copyState, setCopyState] = useState<"idle" | "copying" | "copied">(
        "idle",
    );
    const endpoint = `/api/recordings/${encodeURIComponent(recordingId)}/markdown/${kind}`;
    const documentLabel = kind === "transcript" ? "transcript" : "summary";

    const copyMarkdown = async () => {
        setCopyState("copying");
        try {
            const response = await fetch(endpoint, { cache: "no-store" });
            if (!response.ok) throw new Error("Markdown download failed");
            await navigator.clipboard.writeText(await response.text());
            setCopyState("copied");
            toast.success(
                `${documentLabel === "transcript" ? "Transcript" : "Summary"} Markdown copied`,
            );
            window.setTimeout(() => setCopyState("idle"), 1500);
        } catch {
            setCopyState("idle");
            toast.error(`Failed to copy ${documentLabel} Markdown`);
        }
    };

    return (
        <div className="flex items-center gap-1">
            <Button asChild size="icon-sm" variant="ghost">
                <a
                    href={endpoint}
                    aria-label={`Download ${documentLabel} Markdown`}
                    title={`Download ${documentLabel} Markdown`}
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
                aria-label={`Copy ${documentLabel} Markdown`}
                title={`Copy ${documentLabel} Markdown`}
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
