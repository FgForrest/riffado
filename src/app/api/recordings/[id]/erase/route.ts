import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    eraseLocalArtifact,
    movePlaudRecordingToTrash,
    restoreAudioFromPlaud,
} from "@/lib/recordings/erase";

type IdContext = { params: Promise<{ id: string }> };

const requestSchema = z.object({
    scope: z.enum(["audio", "transcript", "summary", "plaud", "restore-audio"]),
});

export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const parsed = requestSchema.safeParse(
        await request.json().catch(() => null),
    );
    if (!parsed.success) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid erase scope", 400);
    }

    if (parsed.data.scope === "plaud") {
        await movePlaudRecordingToTrash(session.user.id, id);
    } else if (parsed.data.scope === "restore-audio") {
        await restoreAudioFromPlaud(session.user.id, id);
    } else {
        await eraseLocalArtifact(session.user.id, id, parsed.data.scope);
    }

    return NextResponse.json({ success: true, scope: parsed.data.scope });
});
