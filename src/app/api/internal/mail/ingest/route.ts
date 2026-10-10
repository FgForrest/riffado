import { createHash } from "node:crypto";
import { z } from "zod";
import { maxMessageBytes } from "@/lib/mail/config";
import { ingestMail, MAX_RECIPIENTS } from "@/lib/mail/ingest";
import { mailIngestGate } from "@/lib/mail/ingest-gate";

export const dynamic = "force-dynamic";

const recipientsSchema = z
    .array(z.string().trim().toLowerCase().max(320))
    .min(1)
    .max(MAX_RECIPIENTS);

function recipientsOf(request: Request): string[] | null {
    const header = request.headers.get("x-mail-recipients");
    if (!header) return null;
    try {
        const parsed = recipientsSchema.safeParse(
            JSON.parse(Buffer.from(header, "base64").toString("utf8")),
        );
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** The body, read no further than `limit`; null past it. */
async function readRaw(
    request: Request,
    limit: number,
): Promise<Buffer | null> {
    if (!request.body) return Buffer.alloc(0);
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel().catch(() => {});
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

/**
 * The receiver's second step: the raw message, its length and SHA-256 in
 * headers, the envelope recipients in `x-mail-recipients` (base64 JSON).
 * 200 with each recipient's outcome; anything else makes the receiver
 * answer 451 so the sender retries.
 */
export async function POST(request: Request): Promise<Response> {
    const refused = await mailIngestGate(request);
    if (refused) return refused;
    const recipients = recipientsOf(request);
    const length = Number(request.headers.get("content-length"));
    const sha256 = request.headers.get("x-mail-sha256")?.toLowerCase() ?? "";
    if (
        !recipients ||
        !Number.isInteger(length) ||
        length <= 0 ||
        !/^[0-9a-f]{64}$/.test(sha256)
    ) {
        return new Response(null, { status: 400 });
    }
    const limit = maxMessageBytes();
    if (length > limit) return new Response(null, { status: 413 });
    const raw = await readRaw(request, limit);
    if (!raw) return new Response(null, { status: 413 });
    if (
        raw.length !== length ||
        createHash("sha256").update(raw).digest("hex") !== sha256
    ) {
        return new Response(null, { status: 422 });
    }
    const spf = request.headers.get("x-mail-spf")?.slice(0, 32) ?? null;
    try {
        const result = await ingestMail({
            raw,
            recipients,
            spf,
            receivedAt: new Date(),
        });
        return Response.json(result);
    } catch (error) {
        console.error(
            "[mail] ingest failed:",
            error instanceof Error ? error.message : error,
        );
        return new Response(null, { status: 503 });
    }
}
