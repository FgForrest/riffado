import { AppError } from "@/lib/errors";
import {
    type AccessOptions,
    type RecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";

/**
 * Whose data a transcription or summary run touches.
 *
 * On the private view these are all the owner. On the Organization view
 * they split: the recording and the rows written stay the owner's (a shared
 * recording is one recording), the run follows the Organization's prompts
 * and language, and the provider, model and keys are the actor's, who pays
 * for the run.
 */
export interface ContentRunContext {
    view: RecordingView;
    actorUserId: string;
    ownerUserId: string;
    /** Owner of the transcript/summary rows read and written: the recording's owner. */
    contentUserId: string;
    /** Source of prompts, templates and output language. */
    settingsUserId: string;
}

/** Private-view context: every role is the owner. */
export function privateRunContext(ownerUserId: string): ContentRunContext {
    return {
        view: "private",
        actorUserId: ownerUserId,
        ownerUserId,
        contentUserId: ownerUserId,
        settingsUserId: ownerUserId,
    };
}

/**
 * Resolve the context for `actorUserId` running on `recordingId`.
 *
 * Returns null when the actor may not use that view, which callers report the
 * same way as a missing recording.
 */
export async function resolveRunContext(
    actorUserId: string,
    recordingId: string,
    view: RecordingView,
    options: AccessOptions = {},
): Promise<ContentRunContext | null> {
    if (view === "private") return privateRunContext(actorUserId);
    try {
        const access = await requireRecordingView(
            actorUserId,
            recordingId,
            "org",
            options,
        );
        return {
            view,
            actorUserId,
            ownerUserId: access.ownerUserId,
            contentUserId: access.contentUserId,
            // Never null here: the Organization view requires the account.
            settingsUserId: access.orgUserId ?? access.ownerUserId,
        };
    } catch (error) {
        if (error instanceof AppError && error.statusCode === 404) return null;
        throw error;
    }
}
