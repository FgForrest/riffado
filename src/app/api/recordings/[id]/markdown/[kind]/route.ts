import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    getRecordingMarkdownDocument,
    type SidecarKind,
} from "@/lib/export/document-sidecars";
import { contentDispositionAttachment } from "@/lib/recordings/filename";

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
    if (!kind) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Markdown document not found",
            404,
        );
    }

    const document = await getRecordingMarkdownDocument(
        session.user.id,
        id,
        kind,
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
