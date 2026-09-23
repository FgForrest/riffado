import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import {
    createFolderExport,
    listFolderExports,
} from "@/lib/folder-exports/configurations";
import { parseSaveFolderExportInput } from "@/lib/folder-exports/input";

type IdContext = { params: Promise<{ id: string }> };

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    return NextResponse.json(await listFolderExports(session.user.id, id));
});

export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const input = parseSaveFolderExportInput(
        await request.json().catch(() => null),
    );
    const configuration = await createFolderExport(session.user.id, id, input);
    return NextResponse.json({ configuration }, { status: 201 });
});
