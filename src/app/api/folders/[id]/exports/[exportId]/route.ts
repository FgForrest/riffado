import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import {
    deleteFolderExport,
    updateFolderExport,
} from "@/lib/folder-exports/configurations";
import { parseSaveFolderExportInput } from "@/lib/folder-exports/input";

type ExportContext = { params: Promise<{ id: string; exportId: string }> };

export const PATCH = apiHandler<ExportContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id, exportId } = await (context as ExportContext).params;
    const input = parseSaveFolderExportInput(
        await request.json().catch(() => null),
    );
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
