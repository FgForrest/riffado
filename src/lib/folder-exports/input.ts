import { AppError, ErrorCode } from "@/lib/errors";
import { isDocumentFormat, type SaveFolderExportInput } from "./configurations";

/** Validates the JSON body of a create or update export request. */
export function parseSaveFolderExportInput(
    value: unknown,
): SaveFolderExportInput {
    const body = value as Record<string, unknown> | null;
    const invalid = () =>
        new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid export configuration",
            400,
        );
    if (
        !body ||
        typeof body.exportAudio !== "boolean" ||
        typeof body.exportTranscript !== "boolean" ||
        typeof body.exportSummary !== "boolean"
    ) {
        throw invalid();
    }
    const common = {
        exportAudio: body.exportAudio,
        exportTranscript: body.exportTranscript,
        exportSummary: body.exportSummary,
    };
    if (body.provider === "filesystem") {
        if (typeof body.targetPath !== "string") throw invalid();
        return {
            ...common,
            provider: "filesystem",
            targetPath: body.targetPath,
        };
    }
    if (body.provider === "google-drive") {
        if (
            typeof body.rootFolderId !== "string" ||
            !isDocumentFormat(body.transcriptFormat) ||
            !isDocumentFormat(body.summaryFormat)
        ) {
            throw invalid();
        }
        return {
            ...common,
            provider: "google-drive",
            rootFolderId: body.rootFolderId,
            transcriptFormat: body.transcriptFormat,
            summaryFormat: body.summaryFormat,
        };
    }
    throw invalid();
}
