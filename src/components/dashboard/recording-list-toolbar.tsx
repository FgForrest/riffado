"use client";

import {
    ArrowDownAZ,
    FolderTree,
    GraduationCap,
    Search,
    X,
} from "lucide-react";
import { useExtracted } from "next-intl";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

export type SortOrder = "newest" | "oldest" | "name";

/** Which kinds of item the pile shows. */
export type KindFilter = "all" | "audio" | "mail";

export function RecordingListToolbar({
    query,
    onQueryChange,
    onEnterSelectFirst,
    searchRef,
    filteredCount,
    totalCount,
    sortOrder,
    onSortOrderChange,
    onOrganize,
    reviewCount = 0,
    needsReviewOnly = false,
    onNeedsReviewOnlyChange,
    kindFilter,
    onKindFilterChange,
}: {
    query: string;
    onQueryChange: (next: string) => void;
    onEnterSelectFirst: () => void;
    searchRef: React.RefObject<HTMLInputElement | null>;
    filteredCount: number;
    totalCount: number;
    sortOrder: SortOrder;
    onSortOrderChange: (next: SortOrder) => void;
    onOrganize: () => void;
    /** Recordings a Learn review waits on; the toggle shows when there are any. */
    reviewCount?: number;
    needsReviewOnly?: boolean;
    onNeedsReviewOnlyChange?: (next: boolean) => void;
    /** Shown once the pile holds mail; absent hides the filter. */
    kindFilter?: KindFilter;
    onKindFilterChange?: (next: KindFilter) => void;
}) {
    const i18n = useExtracted();
    return (
        <div className="flex flex-col gap-2 border-b p-3">
            <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => onQueryChange(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            onEnterSelectFirst();
                        }
                    }}
                    placeholder={i18n("Search recordings, transcripts...")}
                    className="h-9 pl-8 pr-8"
                    aria-label={i18n("Search recordings")}
                />
                {query && (
                    <button
                        type="button"
                        onClick={() => onQueryChange("")}
                        aria-label={i18n("Clear search")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    >
                        <X className="size-4" />
                    </button>
                )}
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                    {filteredCount}
                    {query ? i18n(" matching") : ""} {i18n("of")} {totalCount}{" "}
                    {i18n("recording")} {totalCount !== 1 ? i18n("s") : ""}
                </span>
                <div className="flex items-center gap-1">
                    {kindFilter && onKindFilterChange && (
                        <fieldset
                            aria-label={i18n("Show")}
                            className="flex items-center rounded-md border p-0.5"
                        >
                            {(
                                [
                                    ["all", i18n("All")],
                                    ["audio", i18n("Audio")],
                                    ["mail", i18n("Mail")],
                                ] as const
                            ).map(([value, label]) => (
                                <button
                                    key={value}
                                    type="button"
                                    aria-pressed={kindFilter === value}
                                    onClick={() => onKindFilterChange(value)}
                                    className={
                                        kindFilter === value
                                            ? "rounded bg-secondary px-1.5 py-0.5 text-foreground"
                                            : "rounded px-1.5 py-0.5 hover:text-foreground"
                                    }
                                >
                                    {label}
                                </button>
                            ))}
                        </fieldset>
                    )}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                aria-label={i18n("Sort")}
                            >
                                <ArrowDownAZ className="size-3.5" />
                                <span>
                                    {sortOrder === "newest"
                                        ? i18n("Newest")
                                        : sortOrder === "oldest"
                                          ? i18n("Oldest")
                                          : i18n("Name")}
                                </span>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>
                                {i18n("Sort by")}
                            </DropdownMenuLabel>
                            <DropdownMenuRadioGroup
                                value={sortOrder}
                                onValueChange={(v) =>
                                    onSortOrderChange(v as SortOrder)
                                }
                            >
                                <DropdownMenuRadioItem value="newest">
                                    {i18n("Newest first")}
                                </DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="oldest">
                                    {i18n("Oldest first")}
                                </DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="name">
                                    {i18n("Name")}
                                </DropdownMenuRadioItem>
                            </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    {reviewCount > 0 && onNeedsReviewOnlyChange && (
                        <Button
                            variant={needsReviewOnly ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 px-2 text-xs"
                            aria-pressed={needsReviewOnly}
                            onClick={() =>
                                onNeedsReviewOnlyChange(!needsReviewOnly)
                            }
                        >
                            <GraduationCap className="size-3.5" />
                            {i18n("Needs review ({count})", {
                                count: String(reviewCount),
                            })}
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={onOrganize}
                    >
                        <FolderTree className="size-3.5" /> {i18n("Organize")}
                    </Button>
                </div>
            </div>
        </div>
    );
}
