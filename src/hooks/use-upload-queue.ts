"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
    PendingUpload,
    PendingUploadPhase,
} from "@/components/dashboard/pending-upload-row";
import { followJob, type JobProgressSnapshot } from "@/lib/jobs/client";

interface Options {
    /** Called after a successful upload so the parent can refresh data. */
    onUploadComplete: () => void;
}

/**
 * Media upload queue: transfer progress, optimistic rows, and durable video
 * conversion tracking. Active conversions are recovered after a page reload.
 *
 * The input is wired by attaching `uploadInputRef` to a hidden input
 * and calling `triggerUpload()` from a visible button. The hook also
 * resets `e.target.value` after pickup so picking the same file twice
 * in a row still fires a `change` event.
 */
export function useUploadQueue({ onUploadComplete }: Options) {
    const [isUploading, setIsUploading] = useState(false);
    const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
    const uploadInputRef = useRef<HTMLInputElement>(null);
    const followers = useRef<Map<string, AbortController>>(new Map());

    const updatePending = useCallback(
        (id: string, update: Partial<PendingUpload>) => {
            setPendingUploads((previous) =>
                previous.map((upload) =>
                    upload.id === id ? { ...upload, ...update } : upload,
                ),
            );
        },
        [],
    );

    const watchConversion = useCallback(
        (jobId: string, placeholderId: string, filename: string) => {
            if (followers.current.has(jobId)) return;
            const controller = new AbortController();
            followers.current.set(jobId, controller);

            void followJob(jobId, {
                signal: controller.signal,
                onProgress: (progress) => {
                    updatePending(placeholderId, pendingFromProgress(progress));
                },
            })
                .then((job) => {
                    if (controller.signal.aborted) return;
                    if (job?.status === "completed") {
                        toast.success(`Audio from "${filename}" is ready`);
                        onUploadComplete();
                    } else {
                        toast.error(
                            job?.error ||
                                `Could not finish converting "${filename}"`,
                        );
                    }
                    setPendingUploads((previous) =>
                        previous.filter(
                            (upload) => upload.id !== placeholderId,
                        ),
                    );
                })
                .finally(() => {
                    followers.current.delete(jobId);
                });
        },
        [onUploadComplete, updatePending],
    );

    useEffect(() => {
        const controller = new AbortController();
        void fetch("/api/recordings/upload", { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) return;
                const body = (await response.json()) as ActiveUploadsResponse;
                if (!Array.isArray(body.uploads)) return;

                for (const upload of body.uploads) {
                    if (
                        typeof upload.jobId !== "string" ||
                        typeof upload.filename !== "string" ||
                        typeof upload.filesize !== "number"
                    ) {
                        continue;
                    }
                    const placeholderId = `conversion:${upload.jobId}`;
                    const progress = pendingFromProgress(upload.progress);
                    setPendingUploads((previous) =>
                        previous.some((item) => item.id === placeholderId)
                            ? previous
                            : [
                                  ...previous,
                                  {
                                      id: placeholderId,
                                      filename: upload.filename,
                                      filesize: upload.filesize,
                                      ...progress,
                                  },
                              ],
                    );
                    watchConversion(
                        upload.jobId,
                        placeholderId,
                        upload.filename,
                    );
                }
            })
            .catch(() => {});

        return () => {
            controller.abort();
            for (const follower of followers.current.values()) {
                follower.abort();
            }
            followers.current.clear();
        };
    }, [watchConversion]);

    const handleUpload = useCallback(
        async (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (!file) return;
            // Reset so picking the same file twice still fires change.
            e.target.value = "";

            // Optimistic placeholder in the list. Uses a `pending:`
            // prefixed id namespace so the row can't collide with a
            // server-issued recording id.
            const placeholderId = `pending:${Date.now()}:${Math.random()
                .toString(36)
                .slice(2)}`;
            setPendingUploads((prev) => [
                ...prev,
                {
                    id: placeholderId,
                    filename: file.name,
                    filesize: file.size,
                    phase: "uploading",
                    progress: 0,
                },
            ]);

            setIsUploading(true);
            let conversionStarted = false;
            try {
                const formData = new FormData();
                formData.append("file", file);
                const data = await sendUpload(formData, (progress) => {
                    updatePending(placeholderId, { progress });
                });

                if (data.conversion && data.jobId) {
                    conversionStarted = true;
                    updatePending(placeholderId, {
                        phase: "queued",
                        progress: null,
                    });
                    toast.success(
                        `"${file.name}" uploaded. Extracting audio in the background.`,
                    );
                    watchConversion(data.jobId, placeholderId, file.name);
                } else {
                    toast.success(`"${data.filename}" uploaded`);
                    onUploadComplete();
                }
            } catch (error) {
                toast.error(
                    error instanceof Error
                        ? error.message
                        : "Failed to upload recording",
                );
            } finally {
                setIsUploading(false);
                if (!conversionStarted) {
                    setPendingUploads((prev) =>
                        prev.filter((p) => p.id !== placeholderId),
                    );
                }
            }
        },
        [onUploadComplete, updatePending, watchConversion],
    );

    const triggerUpload = useCallback(() => {
        uploadInputRef.current?.click();
    }, []);

    return {
        isUploading,
        pendingUploads,
        uploadInputRef,
        handleUpload,
        triggerUpload,
    };
}

interface UploadResponse {
    filename: string;
    conversion?: boolean;
    jobId?: string;
}

interface ActiveUpload {
    jobId: string;
    filename: string;
    filesize: number;
    progress: JobProgressSnapshot | null;
}

interface ActiveUploadsResponse {
    uploads?: ActiveUpload[];
}

function pendingFromProgress(
    progress: JobProgressSnapshot | null,
): Pick<PendingUpload, "phase" | "progress"> {
    const knownPhases: PendingUploadPhase[] = [
        "preparing",
        "extracting",
        "saving",
    ];
    const phase = knownPhases.includes(progress?.phase as PendingUploadPhase)
        ? (progress?.phase as PendingUploadPhase)
        : "queued";
    const percent =
        typeof progress?.completed === "number" &&
        typeof progress.total === "number" &&
        progress.total > 0
            ? Math.round((progress.completed / progress.total) * 100)
            : null;
    return { phase, progress: percent };
}

function sendUpload(
    formData: FormData,
    onProgress: (progress: number) => void,
): Promise<UploadResponse> {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", "/api/recordings/upload");
        request.upload.addEventListener("progress", (event) => {
            if (!event.lengthComputable || event.total <= 0) return;
            onProgress(
                Math.min(100, Math.round((event.loaded / event.total) * 100)),
            );
        });
        request.addEventListener("load", () => {
            let body: { error?: string } & Partial<UploadResponse> = {};
            try {
                body = JSON.parse(request.responseText) as typeof body;
            } catch {
                body = {};
            }
            if (
                request.status >= 200 &&
                request.status < 300 &&
                typeof body.filename === "string"
            ) {
                resolve({
                    filename: body.filename,
                    conversion: body.conversion,
                    jobId: body.jobId,
                });
                return;
            }
            reject(new Error(body.error || "Upload failed"));
        });
        request.addEventListener("error", () => {
            reject(new Error("Failed to upload recording"));
        });
        request.send(formData);
    });
}
