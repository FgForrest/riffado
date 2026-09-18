import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    deleteFolderExport,
    type SaveFolderExportInput,
    updateFolderExport,
} from "@/lib/folder-exports/configurations";

type ExportContext = { params: Promise<{ id: string; exportId: string }> };

function parseInput(value: unknown): SaveFolderExportInput {
    const body = value as Record<string, unknown> | null;
    if (
        !body ||
        body.provider !== "filesystem" ||
        typeof body.targetPath !== "string" ||
        typeof body.exportAudio !== "boolean" ||
        typeof body.exportTranscript !== "boolean" ||
        typeof body.exportSummary !== "boolean"
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid export configuration",
            400,
        );
    }
    return {
        targetPath: body.targetPath,
        exportAudio: body.exportAudio,
        exportTranscript: body.exportTranscript,
        exportSummary: body.exportSummary,
    };
}

export const PATCH = apiHandler<ExportContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id, exportId } = await (context as ExportContext).params;
    const input = parseInput(await request.json().catch(() => null));
    const configuration = await updateFolderExport(
        session.user.id,
        id,
        exportId,
        input,
    );
    return NextResponse.json({ configuration });
});

export const DELETE = apiHandler<ExportContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id, exportId } = await (context as ExportContext).params;
    await deleteFolderExport(session.user.id, id, exportId);
    return NextResponse.json({ deleted: true });
});
