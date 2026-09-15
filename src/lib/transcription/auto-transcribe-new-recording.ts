import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { enqueueTranscriptionJob } from "@/lib/transcription/transcription-job";

/** Queue transcription when the recording owner's setting is enabled. */
export async function autoTranscribeNewRecording(
    userId: string,
    recordingId: string,
): Promise<boolean> {
    const [settings] = await db
        .select({ autoTranscribe: userSettings.autoTranscribe })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);

    if (!settings?.autoTranscribe) return false;
    await enqueueTranscriptionJob({ userId, recordingId });
    return true;
}
