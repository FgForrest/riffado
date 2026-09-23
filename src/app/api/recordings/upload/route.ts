import * as path from "node:path";
import { nanoid } from "nanoid";
import { NextResponse } from "next/server";
import { listJobsForUser } from "@/db/queries/async-jobs";
import { requireApiSession } from "@/lib/auth-server";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { isHostedLockedOut } from "@/lib/entitlements";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { enforceStorageCap } from "@/lib/hosted/billing/storage-cap";
import { assertNotOrgAccount } from "@/lib/org/config";
import { createUserStorageProvider } from "@/lib/storage/factory";
import {
    acceptedUploadExtensions,
    isSupportedUpload,
    shouldExtractVideo,
    uploadExtension,
} from "@/lib/uploads/media-types";
import { saveUploadedAudio } from "@/lib/uploads/save-uploaded-audio";
import {
    enqueueVideoExtractionJob,
    parseVideoExtractionJobPayload,
    VIDEO_EXTRACTION_JOB_KIND,
} from "@/lib/uploads/video-extraction-job";

export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const jobs = await listJobsForUser(session.user.id, {
        kind: VIDEO_EXTRACTION_JOB_KIND,
        activeOnly: true,
        limit: 20,
    });

    const uploads = jobs.flatMap((job) => {
        try {
            const payload = parseVideoExtractionJobPayload(job.payload);
            return [
                {
                    jobId: job.id,
                    filename: decryptText(payload.encryptedFilename),
                    filesize: payload.sourceSize,
                    status: job.status,
                    progress: job.progress,
                },
            ];
        } catch {
            return [];
        }
    });

    return NextResponse.json({ uploads });
});

export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    await assertNotOrgAccount(session.user.id);

    if (await isHostedLockedOut(session.user.id)) {
        throw new AppError(
            ErrorCode.ACCOUNT_LOCKED,
            "Your hosted plan has lapsed. Subscribe to resume uploads, or export your data.",
            403,
        );
    }

    const formData = await request.formData();
    const fileEntry = formData.get("file");

    if (!fileEntry || !(fileEntry instanceof File)) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "No file provided",
            400,
            { field: "file" },
        );
    }

    const file = fileEntry;

    // Reject files larger than 500 MB
    const MAX_FILE_SIZE = 500 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
        throw new AppError(
            ErrorCode.FILE_TOO_LARGE,
            "File exceeds the 500 MB size limit",
            413,
        );
    }

    // Storage cap: block the upload before reading the body when it would
    // push the user over their plan's storage limit. No-op on self-host.
    const cap = await enforceStorageCap({
        userId: session.user.id,
        additionalBytes: file.size,
    });
    if (!cap.allowed) {
        throw new AppError(
            ErrorCode.STORAGE_QUOTA_EXCEEDED,
            "This upload would exceed your plan's storage limit. Upgrade or free up space to continue.",
            413,
        );
    }

    const ext = uploadExtension(file.name);

    if (!isSupportedUpload(file.name, file.type)) {
        throw new AppError(
            ErrorCode.INVALID_FILE_FORMAT,
            `Unsupported format. Upload a browser-recognized video or use one of these extensions: ${acceptedUploadExtensions()}`,
            400,
        );
    }

    // Read file into buffer (inline to avoid keeping the intermediate
    // ArrayBuffer in scope alongside the Buffer, which would briefly
    // double memory usage for large files)
    const buffer = Buffer.from(await file.arrayBuffer());

    const storage = await createUserStorageProvider(session.user.id);
    const basename = path.basename(file.name, ext);

    if (shouldExtractVideo(file.name, file.type)) {
        const uploadId = nanoid();
        const sourceStorageKey = `${session.user.id}/video-uploads/${uploadId}`;
        await storage.uploadFile(
            sourceStorageKey,
            buffer,
            "application/octet-stream",
        );

        try {
            const enqueued = await enqueueVideoExtractionJob({
                uploadId,
                sourceStorageKey,
                encryptedFilename: encryptText(file.name),
                sourceSize: buffer.length,
                userId: session.user.id,
            });
            if (!enqueued.created) {
                throw new AppError(
                    ErrorCode.RATE_LIMITED,
                    "Another video is already being converted. Try this upload again when it finishes.",
                    429,
                );
            }
            return NextResponse.json(
                {
                    success: true,
                    filename: basename,
                    conversion: true,
                    jobId: enqueued.job.id,
                },
                { status: 202 },
            );
        } catch (queueError) {
            try {
                await storage.deleteFile(sourceStorageKey);
            } catch (cleanupError) {
                console.error(
                    "Failed to clean up video after queueing error:",
                    cleanupError,
                );
            }
            throw queueError;
        }
    }

    const fileId = `uploaded-${nanoid()}`;
    await saveUploadedAudio({
        userId: session.user.id,
        fileId,
        basename,
        extension: ext,
        buffer,
        storage,
        sourceExtension: ext,
        convertedFromVideo: false,
    });

    return NextResponse.json({ success: true, filename: basename });
});
