import {
    type AsyncJobRow,
    getJobById,
    getJobForUser,
} from "@/db/queries/async-jobs";
import { AppError } from "@/lib/errors";
import { requireRecordingView } from "@/lib/sharing/access";

const ORG_SUBJECT_PREFIX = "org:";

/**
 * A job `userId` may follow: their own, or an Organization job on a
 * recording they can currently see in the Organization view.
 */
export async function getJobVisibleTo(
    jobId: string,
    userId: string,
): Promise<AsyncJobRow | null> {
    const own = await getJobForUser(jobId, userId);
    if (own) return own;
    const job = await getJobById(jobId);
    if (!job?.subjectId?.startsWith(ORG_SUBJECT_PREFIX)) return null;
    try {
        await requireRecordingView(
            userId,
            job.subjectId.slice(ORG_SUBJECT_PREFIX.length),
            "org",
        );
        return job;
    } catch (error) {
        if (error instanceof AppError && error.statusCode === 404) return null;
        throw error;
    }
}
