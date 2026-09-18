import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    createFolderExport,
    listFolderExports,
    type SaveFolderExportInput,
} from "@/lib/folder-exports/configurations";

type IdContext = { params: Promise<{ id: string }> };

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

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    return NextResponse.json(await listFolderExports(session.user.id, id));
});

export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const input = parseInput(await request.json().catch(() => null));
    const configuration = await createFolderExport(session.user.id, id, input);
    return NextResponse.json({ configuration }, { status: 201 });
});
