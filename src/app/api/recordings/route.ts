import { and, desc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import {
    audioItemColumns,
    recordingItemJoin,
    toRecordingResponseRow,
} from "@/db/items";
import { chatterItems, recordings } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { decryptText } from "@/lib/encryption/fields";
import { apiHandler } from "@/lib/errors";

export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const userRecordings = await db
        .select(audioItemColumns)
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                eq(recordings.userId, session.user.id),
                isNull(recordings.deletedAt),
            ),
        )
        .orderBy(desc(chatterItems.occurredAt));

    return NextResponse.json({
        recordings: userRecordings.map((row) => {
            const recording = toRecordingResponseRow(row);
            return { ...recording, filename: decryptText(recording.filename) };
        }),
    });
});
