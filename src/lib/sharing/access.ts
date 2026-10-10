import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { type ChatterItemKind, chatterItems, recordings } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { getOrgUserId } from "@/lib/org/config";
import { isRecordingShared } from "@/lib/sharing/shared";
import type { RecordingView } from "@/lib/sharing/view";

export {
    isRecordingShared,
    sharedRecordingCondition,
} from "@/lib/sharing/shared";

export type { RecordingView } from "@/lib/sharing/view";
export { recordingJobSubject } from "@/lib/sharing/view";

/**
 * - `owner`: the recording's owner.
 * - `member`: any other regular user, on a shared recording.
 * - `curator`: the organization account, on a shared recording.
 */
export type RecordingAccessRole = "owner" | "member" | "curator";

export interface RecordingAccess {
    recordingId: string;
    /** What the item is: a recording unless the caller admitted other kinds. */
    kind: ChatterItemKind;
    ownerUserId: string;
    role: RecordingAccessRole;
    shared: boolean;
    orgUserId: string | null;
}

export interface RecordingViewContext extends RecordingAccess {
    view: RecordingView;
    /**
     * Owner of the transcript and summary rows this view reads and writes:
     * the recording's owner in both views. A shared recording is one
     * recording; the views differ in who may change it, not in its rows.
     */
    contentUserId: string;
}

export interface AccessOptions {
    /**
     * The item kinds the caller handles. A recording only by default, so a
     * route made for audio answers 404 for a mail id before doing anything.
     */
    kinds?: readonly ChatterItemKind[];
}

async function findItem(
    itemId: string,
    kinds: readonly ChatterItemKind[] | undefined,
): Promise<{ userId: string; kind: ChatterItemKind } | null> {
    if (!kinds || (kinds.length === 1 && kinds[0] === "audio")) {
        const [recording] = await db
            .select({ id: recordings.id, userId: recordings.userId })
            .from(recordings)
            .where(and(eq(recordings.id, itemId), isNull(recordings.deletedAt)))
            .limit(1);
        return recording ? { userId: recording.userId, kind: "audio" } : null;
    }
    const [item] = await db
        .select({ userId: chatterItems.userId, kind: chatterItems.kind })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                inArray(chatterItems.kind, [...kinds]),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    return item ?? null;
}

/**
 * Who `userId` is to `recordingId`, or null when they may not see it at all.
 *
 * Callers turn null into a 404 so the answer never reveals that a recording
 * exists.
 */
export async function resolveRecordingAccess(
    userId: string,
    recordingId: string,
    options: AccessOptions = {},
): Promise<RecordingAccess | null> {
    const recording = await findItem(recordingId, options.kinds);
    if (!recording) return null;

    const orgUserId = await getOrgUserId();
    const shared = orgUserId
        ? await isRecordingShared(recordingId, orgUserId)
        : false;

    if (recording.userId === userId) {
        return {
            recordingId,
            kind: recording.kind,
            ownerUserId: recording.userId,
            role: "owner",
            shared,
            orgUserId,
        };
    }
    if (!shared) return null;
    return {
        recordingId,
        kind: recording.kind,
        ownerUserId: recording.userId,
        role: userId === orgUserId ? "curator" : "member",
        shared,
        orgUserId,
    };
}

/** Read `?view=org` from a request URL; anything else is the private view. */
export function requestedRecordingView(request: Request): RecordingView {
    return new URL(request.url).searchParams.get("view") === "org"
        ? "org"
        : "private";
}

/**
 * Authorize a request against one view of a recording.
 *
 * The private view is the owner's alone. The Organization view exists only
 * while the recording is shared, for the owner and every other account.
 */
export async function requireRecordingView(
    userId: string,
    recordingId: string,
    view: RecordingView,
    options: AccessOptions = {},
): Promise<RecordingViewContext> {
    const access = await resolveRecordingAccess(userId, recordingId, options);
    const allowed =
        access !== null &&
        (view === "private"
            ? access.role === "owner"
            : access.shared && access.orgUserId !== null);
    if (!access || !allowed) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    return { ...access, view, contentUserId: access.ownerUserId };
}

/**
 * Authorize a view-independent read of a recording (its audio, its
 * waveform): the owner, or anyone while it is shared.
 */
export async function requireRecordingAccess(
    userId: string,
    recordingId: string,
    options: AccessOptions = {},
): Promise<RecordingAccess> {
    const access = await resolveRecordingAccess(userId, recordingId, options);
    if (!access) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    return access;
}
