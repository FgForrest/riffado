"use client";

import { Loader2, RefreshCw, Sparkles, Tag } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    activeTopicIndex,
    formatClock,
    type TranscriptTopic,
} from "@/lib/topics/timeline";

interface TranscriptTopicsMenuProps {
    topics: TranscriptTopic[] | null;
    /** The transcript has timings and belongs to the viewer. */
    canDetect: boolean;
    detecting: boolean;
    onDetect: () => void;
    onSelect: (index: number) => void;
    /** Playback position, to mark the topic being played. */
    getPlaybackMs?: () => number;
}

/**
 * "Topics (n)" beside the transcript's collapse toggle: the chapters of the
 * conversation, each a jump to where it starts. Without topics it offers to
 * detect them, when the transcript has the timings they need.
 */
export function TranscriptTopicsMenu({
    topics,
    canDetect,
    detecting,
    onDetect,
    onSelect,
    getPlaybackMs,
}: TranscriptTopicsMenuProps) {
    const i18n = useExtracted();
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);
    // A ref, so a parent passing a fresh function each render does not
    // restart the timer below.
    const playbackRef = useRef(getPlaybackMs);
    playbackRef.current = getPlaybackMs;

    // Follow playback while the list is open, so the highlighted topic is
    // the one playing now rather than the one playing when it was opened.
    useEffect(() => {
        if (!open || !topics?.length) return;
        const update = () => {
            const ms = playbackRef.current?.();
            setActive(ms === undefined ? -1 : activeTopicIndex(topics, ms));
        };
        update();
        const timer = setInterval(update, 1000);
        return () => clearInterval(timer);
    }, [open, topics]);

    if (!topics?.length) {
        if (!canDetect) return null;
        return (
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto px-1.5 py-0.5 text-sm font-medium text-muted-foreground hover:text-primary"
                onClick={onDetect}
                disabled={detecting}
            >
                {detecting ? (
                    <Loader2 className="size-4 animate-spin" />
                ) : (
                    <Sparkles className="size-4" />
                )}
                {detecting ? i18n("Detecting topics…") : i18n("Detect topics")}
            </Button>
        );
    }

    return (
        <div className="flex items-center gap-2">
            <DropdownMenu open={open} onOpenChange={setOpen}>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        className="flex items-center gap-1 rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <Tag className="size-4" />
                        {i18n("Topics ({count, number})", {
                            count: topics.length,
                        })}
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    align="start"
                    collisionPadding={16}
                    className="max-h-[60vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
                >
                    <DropdownMenuLabel>
                        {i18n("Conversation topics")}
                    </DropdownMenuLabel>
                    {topics.map((topic, index) => (
                        <DropdownMenuItem
                            key={`${topic.fromMs}-${topic.title}`}
                            onSelect={() => onSelect(index)}
                            className={`items-baseline gap-3 ${index === active ? "bg-primary/10 text-primary" : ""}`}
                        >
                            <span className="w-5 shrink-0 text-right font-semibold tabular-nums text-primary">
                                {index + 1}.
                            </span>
                            <span className="min-w-0 flex-1 break-words">
                                {topic.title}
                            </span>
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                {formatClock(topic.fromMs)}
                            </span>
                        </DropdownMenuItem>
                    ))}
                    {canDetect && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                onSelect={onDetect}
                                disabled={detecting}
                                className="text-muted-foreground"
                            >
                                <RefreshCw />
                                {i18n("Detect topics again")}
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            {detecting && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    {i18n("Detecting topics…")}
                </span>
            )}
        </div>
    );
}
