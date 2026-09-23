import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    getRecordingMarkdownDocument,
    type SidecarKind,
} from "@/lib/export/document-sidecars";
import { contentDispositionAttachment } from "@/lib/recordings/filename";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { effectiveViewReader } from "@/lib/sharing/view-content";

type MarkdownContext = {
    params: Promise<{ id: string; kind: string }>;
};

function sidecarKind(value: string): SidecarKind | null {
    return value === "transcript" || value === "summary" ? value : null;
}

export const GET = apiHandler<MarkdownContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id, kind: rawKind } = await (context as MarkdownContext).params;
    const kind = sidecarKind(rawKind);
    const source = new URL(request.url).searchParams.get("source") ?? undefined;
    if (!kind) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Markdown document not found",
            404,
        );
    }

    const view = requestedRecordingView(request);
    const access = await requireRecordingView(session.user.id, id, view);
    const reader = await effectiveViewReader(id, access, kind);
    const document = await getRecordingMarkdownDocument(
        reader.userId,
        id,
        kind,
        source,
        access.ownerUserId,
        view === "org",
    );
    if (!document) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Markdown document not found",
            404,
        );
    }

    return new Response(document.content, {
        headers: {
            "Cache-Control": "private, no-store",
            "Content-Disposition": contentDispositionAttachment(
                document.filename,
            ),
            "Content-Type": "text/markdown; charset=utf-8",
        },
    });
});
