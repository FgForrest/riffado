import { z } from "zod";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { MAX_DKIM_SIGNATURES } from "@/lib/mail/dkim";
import { MAX_RECIPIENTS, precheckMail } from "@/lib/mail/ingest";
import { mailIngestGate } from "@/lib/mail/ingest-gate";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

const address = z.string().trim().toLowerCase().max(320);

const precheckSchema = z.object({
    recipients: z.array(address).min(1).max(MAX_RECIPIENTS),
    facts: z.object({
        fromHeaders: z.number().int().min(0).max(50),
        fromAddresses: z.array(address).max(50),
        dkim: z
            .array(
                z.object({
                    domain: z.string().trim().toLowerCase().max(253),
                    result: z.string().max(32),
                    signedRecipients: z.array(address).max(500),
                    signedAt: z.string().datetime().nullable(),
                }),
            )
            .max(MAX_DKIM_SIGNATURES),
    }),
});

/**
 * The receiver's first step: which recipients of a message would pass, by
 * its metadata alone. The raw message is sent only when some would.
 */
export async function POST(request: Request): Promise<Response> {
    const refused = await mailIngestGate(request);
    if (refused) return refused;
    const read = await readBoundedJson(request, MAX_BODY_BYTES);
    if (read.tooLarge) return new Response(null, { status: 413 });
    const parsed = precheckSchema.safeParse(read.body);
    if (!parsed.success) return new Response(null, { status: 400 });
    const { recipients, facts } = parsed.data;
    const result = await precheckMail({
        recipients,
        facts: {
            fromHeaders: facts.fromHeaders,
            fromAddresses: facts.fromAddresses,
            dkim: facts.dkim.map((signature) => ({
                ...signature,
                signedAt: signature.signedAt
                    ? new Date(signature.signedAt)
                    : null,
            })),
            receivedAt: new Date(),
        },
    });
    return Response.json(result);
}
