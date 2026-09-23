import { enqueueExportPlansForUser } from "@/lib/folder-exports/jobs";
import { getOrgUserId } from "@/lib/org/config";
import { notifyOrgChange } from "@/lib/org/events";
import { isRecordingShared } from "@/lib/sharing/shared";

/**
 * The Organization view of a recording changed: tell every open tab, and
 * re-plan the organization's filesystem exports, which project that view.
 * Best effort, like every notification: it never fails the change itself.
 */
export async function orgContentChanged(recordingId: string): Promise<void> {
    await notifyOrgChange({ type: "recording", recordingId });
    try {
        const orgUserId = await getOrgUserId();
        if (orgUserId) await enqueueExportPlansForUser(orgUserId);
    } catch (error) {
        console.error("[org-events] could not schedule exports:", error);
    }
}

/**
 * Tell Organization viewers that the owner changed a shared recording.
 *
 * Until the organization has its own rows, its view shows the owner's
 * transcript and summary, and always the owner's title -- so an owner's
 * private rename or re-run is news to everyone. Best effort, like every
 * notification: it never fails the change that caused it.
 */
export async function notifyIfShared(recordingId: string): Promise<void> {
    try {
        const orgUserId = await getOrgUserId();
        if (!orgUserId) return;
        if (await isRecordingShared(recordingId, orgUserId)) {
            await orgContentChanged(recordingId);
        }
    } catch (error) {
        console.error("[org-events] could not check sharing:", error);
    }
}
