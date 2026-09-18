import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { assertFilesystemExportsAvailable } from "@/lib/folder-exports/configurations";
import { enqueueExportReconciliation } from "@/lib/folder-exports/jobs";

type IdContext = { params: Promise<{ id: string }> };

export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    assertFilesystemExportsAvailable();
    const { id } = await (context as IdContext).params;
    const { job, created } = await enqueueExportReconciliation(
        session.user.id,
        id,
    );
    return NextResponse.json({ jobId: job.id, created }, { status: 202 });
});
