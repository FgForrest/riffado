import { and, eq, isNull } from "drizzle-orm";
import { chatterItems, recordings } from "@/db/schema";
import {
    sharedItemCondition,
    sharedRecordingCondition,
} from "@/lib/sharing/shared";

/**
 * Whose content a backup or an export carries: one person's own, or the
 * Organization's. Never both, and never chosen by the request: the account
 * asking decides it.
 */
export type ArchiveScope =
    | { kind: "personal"; userId: string }
    | { kind: "organization"; orgUserId: string };

/** The account a scope's own knowledge rows (`userId`) belong to. */
export function scopeUserId(scope: ArchiveScope): string {
    return scope.kind === "personal" ? scope.userId : scope.orgUserId;
}

/**
 * SQL predicate on `recordings`: the live recordings a scope carries. A
 * person's own, shared ones included; for the Organization, every shared
 * one, whoever owns it.
 */
export function archivedRecordingCondition(scope: ArchiveScope) {
    return and(
        scope.kind === "personal"
            ? eq(recordings.userId, scope.userId)
            : sharedRecordingCondition(scope.orgUserId),
        isNull(recordings.deletedAt),
    );
}

/** `archivedRecordingCondition` on `chatter_items`: items of every kind. */
export function archivedItemCondition(scope: ArchiveScope) {
    return and(
        scope.kind === "personal"
            ? eq(chatterItems.userId, scope.userId)
            : sharedItemCondition(scope.orgUserId),
        isNull(chatterItems.deletedAt),
    );
}
