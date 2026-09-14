import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    createPerson,
    findPersonByEmail,
    listPeople,
    MAX_DISPLAY_NAME_LENGTH,
} from "@/lib/knowledge/people";

const MAX_EMAIL_LENGTH = 320;
const MAX_NOTES_LENGTH = 4000;

export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    return NextResponse.json({ people: await listPeople(session.user.id) });
});

export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const body = (await request.json().catch(() => null)) as {
        displayName?: unknown;
        primaryEmail?: unknown;
        notes?: unknown;
    } | null;

    const displayName = readString(
        body?.displayName,
        MAX_DISPLAY_NAME_LENGTH,
        "name",
    );
    if (!displayName) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "A person needs a name",
            400,
            { field: "displayName" },
        );
    }
    const primaryEmail = readString(
        body?.primaryEmail,
        MAX_EMAIL_LENGTH,
        "email",
    );
    const notes = readString(body?.notes, MAX_NOTES_LENGTH, "notes");

    // Two people with one address is always a mistake rather than an intent,
    // and catching it here is friendlier than surfacing a unique violation.
    if (primaryEmail) {
        const existing = await findPersonByEmail(session.user.id, primaryEmail);
        if (existing) {
            throw new AppError(
                ErrorCode.CONFLICT,
                `${existing.displayName} already has that email address`,
                409,
                { field: "primaryEmail" },
            );
        }
    }

    const person = await createPerson({
        userId: session.user.id,
        displayName,
        primaryEmail,
        notes,
    });

    return NextResponse.json({ person }, { status: 201 });
});

function readString(
    value: unknown,
    maxLength: number,
    field: string,
): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `Expected ${field} to be text`,
            400,
            { field },
        );
    }
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > maxLength) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `That ${field} is too long`,
            400,
            { field },
        );
    }
    return trimmed;
}
