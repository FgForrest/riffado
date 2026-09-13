import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { apiCredentials } from "@/db/schema";
import { isTranscriptionOnlyProvider } from "@/lib/ai/provider-presets";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    isRiffadoIncludedProviderId,
    RIFFADO_INCLUDED_PROVIDER_LABEL,
} from "@/lib/transcription/included-provider";

const bodySchema = z.object({
    providerId: z.string().min(1),
});

/**
 * Set the default AI-enhancement provider.
 *
 * The mirror of `default-transcription`, and it exists for the same
 * reason: the provider list needs a one-click switch. Going through
 * `PATCH /providers/[id]` instead would be destructive -- that handler
 * writes `baseUrl: baseUrl || null` and `defaultModel: defaultModel ||
 * null`, so a body carrying only the flag would blank both fields.
 *
 * Unlike transcription, the default lives on the credential row
 * (`isDefaultEnhancement`) rather than behind a pointer in
 * `userSettings`, so "set" means "clear every other row, then set this
 * one" -- in one transaction, or a failure between the two leaves the
 * user with no default at all.
 */
export const PUT = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const raw = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid request body",
            400,
            { issues: parsed.error.flatten() },
        );
    }

    const { providerId } = parsed.data;

    // The managed transcription entry is not a credential row and holds
    // no key that could reach a chat/completions endpoint.
    if (isRiffadoIncludedProviderId(providerId)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `${RIFFADO_INCLUDED_PROVIDER_LABEL} transcribes only. Pick another provider for AI enhancements.`,
            400,
            { field: "providerId" },
        );
    }

    const [provider] = await db
        .select({
            id: apiCredentials.id,
            provider: apiCredentials.provider,
        })
        .from(apiCredentials)
        .where(
            and(
                eq(apiCredentials.id, providerId),
                eq(apiCredentials.userId, session.user.id),
            ),
        )
        .limit(1);

    if (!provider) {
        throw new AppError(ErrorCode.NOT_FOUND, "Provider not found", 404);
    }

    if (isTranscriptionOnlyProvider(provider.provider)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `${provider.provider} transcribes only. Summaries need an OpenAI-compatible provider.`,
            400,
            { field: "providerId" },
        );
    }

    await db.transaction(async (tx) => {
        await tx
            .update(apiCredentials)
            .set({ isDefaultEnhancement: false })
            .where(
                and(
                    eq(apiCredentials.userId, session.user.id),
                    eq(apiCredentials.isDefaultEnhancement, true),
                ),
            );

        await tx
            .update(apiCredentials)
            .set({ isDefaultEnhancement: true, updatedAt: new Date() })
            .where(
                and(
                    eq(apiCredentials.id, providerId),
                    eq(apiCredentials.userId, session.user.id),
                ),
            );
    });

    return NextResponse.json({ success: true });
});
