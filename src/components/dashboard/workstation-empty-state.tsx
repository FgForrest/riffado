"use client";

import { Mic, RefreshCw, Upload } from "lucide-react";
import { useExtracted } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface Props {
    isSyncing: boolean;
    onSync: () => void;
    onUpload: () => void;
}

/**
 * Shown when the user has no recordings yet (and no in-flight upload).
 * Offers the two paths into having content: sync from a Plaud device
 * (the common case) or upload an audio or video file from disk.
 */
export function WorkstationEmptyState({ isSyncing, onSync, onUpload }: Props) {
    const i18n = useExtracted();
    return (
        <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
                <Mic className="mb-4 size-16 text-muted-foreground" />
                <h3 className="mb-2 text-lg font-semibold">
                    {i18n("No recordings yet")}
                </h3>
                <p className="mb-6 max-w-md text-center text-sm text-muted-foreground">
                    {i18n(
                        "Sync your Plaud device to import your recordings and start transcribing them.",
                    )}
                </p>
                <div className="flex gap-2">
                    <Button onClick={onSync} disabled={isSyncing}>
                        {isSyncing ? (
                            <>
                                <RefreshCw className="mr-2 size-4 animate-spin" />{" "}
                                {i18n("Syncing…")}
                            </>
                        ) : (
                            <>
                                <RefreshCw className="mr-2 size-4" />{" "}
                                {i18n("Sync Device")}
                            </>
                        )}
                    </Button>
                    <Button variant="outline" onClick={onUpload}>
                        <Upload className="mr-2 size-4" /> {i18n("Upload")}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
