"use client";

import { Download } from "lucide-react";
import { useExtracted } from "next-intl";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { recordingAudioDownloadPath } from "@/lib/recordings/filename";

export function DownloadAudioButton({ recordingId }: { recordingId: string }) {
    const i18n = useExtracted();
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button asChild variant="ghost" size="icon-sm">
                    <a
                        href={recordingAudioDownloadPath(recordingId)}
                        download
                        rel="nofollow noreferrer"
                        aria-label={i18n("Download original audio")}
                    >
                        <Download className="size-4" />
                    </a>
                </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
                {i18n("Download original audio")}
            </TooltipContent>
        </Tooltip>
    );
}
