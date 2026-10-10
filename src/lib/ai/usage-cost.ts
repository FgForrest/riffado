import { and, eq } from "drizzle-orm";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { db } from "@/db";
import { aiUsageEvents, apiCredentials } from "@/db/schema";
import {
    type AiRate,
    PRICE_SOURCE,
    publishedRate,
    storedRate,
} from "@/lib/ai/published-rates";

export type AiOperation =
    | "transcription"
    | "summary"
    | "topics"
    | "learn"
    | "correction"
    | "title";

export interface AiUsageContext {
    recordingId: string;
    ownerUserId: string;
    payerUserId: string;
    operation: AiOperation;
    provider: string;
    model: string;
    baseUrl?: string | null;
    /** The provider card the call went through; its own rate wins. */
    credentialId?: string | null;
}

interface UsageValues {
    inputTokens?: number | null;
    outputTokens?: number | null;
    audioSeconds?: number | null;
    reportedCostUsd?: number | null;
    /** Keyterms sent with an ElevenLabs transcription, priced as an add-on. */
    keytermCount?: number;
}

// ElevenLabs keyterm prompting: an hourly add-on, and past this many terms
// a request bills at least `KEYTERM_MIN_BILLABLE_SECONDS`.
const ELEVENLABS_KEYTERMS_USD_PER_HOUR = 0.05;
const KEYTERM_MIN_BILLING_THRESHOLD = 100;
const KEYTERM_MIN_BILLABLE_SECONDS = 20;

function positiveFinite(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : null;
}

/** Price one request in USD, preserving an unknown price as null. */
export function estimateAiUsage(
    context: AiUsageContext,
    usage: UsageValues,
    customRate?: AiRate | null,
): {
    inputTokens: number | null;
    outputTokens: number | null;
    audioSeconds: number | null;
    cost: number | null;
    source: string | null;
} {
    const inputTokens = positiveFinite(usage.inputTokens);
    const outputTokens = positiveFinite(usage.outputTokens);
    const audioSeconds = positiveFinite(usage.audioSeconds);
    const reportedCost = positiveFinite(usage.reportedCostUsd);
    let cost: number | null = reportedCost;
    let source: string | null = reportedCost === null ? null : "provider";
    const catalog = publishedRate(
        context.provider,
        context.model,
        context.baseUrl,
    );

    if (cost === null && inputTokens !== null && outputTokens !== null) {
        const manualRates: [number, number] | null =
            customRate?.inputUsdPerMillion != null &&
            customRate.outputUsdPerMillion != null
                ? [
                      customRate.inputUsdPerMillion,
                      customRate.outputUsdPerMillion,
                  ]
                : null;
        const rates: [number, number] | null =
            manualRates ??
            (catalog?.inputUsdPerMillion != null &&
            catalog.outputUsdPerMillion != null
                ? [catalog.inputUsdPerMillion, catalog.outputUsdPerMillion]
                : null);
        if (rates) {
            cost =
                (inputTokens * rates[0] + outputTokens * rates[1]) / 1_000_000;
            source = manualRates ? "user" : PRICE_SOURCE;
        }
    }
    if (cost === null && audioSeconds !== null) {
        const keyterms =
            context.provider === "ElevenLabs"
                ? Math.max(0, usage.keytermCount ?? 0)
                : 0;
        const published =
            customRate?.audioUsdPerHour == null
                ? (catalog?.audioUsdPerHour ?? null)
                : null;
        let rate = customRate?.audioUsdPerHour ?? published;
        let minimumSeconds = 0;
        if (context.provider === "Groq") {
            minimumSeconds = 10;
        } else if (published !== null && keyterms > 0) {
            rate = published + ELEVENLABS_KEYTERMS_USD_PER_HOUR;
            if (keyterms > KEYTERM_MIN_BILLING_THRESHOLD) {
                minimumSeconds = KEYTERM_MIN_BILLABLE_SECONDS;
            }
        }
        if (rate !== null) {
            const billableSeconds = Math.max(minimumSeconds, audioSeconds);
            cost = (billableSeconds * rate) / 3600;
            source =
                customRate?.audioUsdPerHour != null ? "user" : PRICE_SOURCE;
        }
    }

    return { inputTokens, outputTokens, audioSeconds, cost, source };
}

/**
 * The rate set on the provider card the call went through. It prices that
 * card's own model only: a call that fell back to another model (a
 * Whisper card writing a title through `gpt-4o-mini`) is not what the
 * user priced.
 */
async function cardRate(context: AiUsageContext): Promise<AiRate | null> {
    if (!context.credentialId) return null;
    const [card] = await db
        .select({
            defaultModel: apiCredentials.defaultModel,
            inputUsdPerMillion: apiCredentials.inputUsdPerMillion,
            outputUsdPerMillion: apiCredentials.outputUsdPerMillion,
            audioUsdPerHour: apiCredentials.audioUsdPerHour,
        })
        .from(apiCredentials)
        .where(
            and(
                eq(apiCredentials.id, context.credentialId),
                eq(apiCredentials.userId, context.payerUserId),
            ),
        )
        .limit(1);
    if (!card) return null;
    if (card.defaultModel && card.defaultModel !== context.model) return null;
    return storedRate(card);
}

/** Store measured provider usage and a rate snapshot for one completed call. */
export async function recordAiUsage(
    context: AiUsageContext,
    usage: UsageValues,
): Promise<void> {
    try {
        const { inputTokens, outputTokens, audioSeconds, cost, source } =
            estimateAiUsage(context, usage, await cardRate(context));
        await db.insert(aiUsageEvents).values({
            itemId: context.recordingId,
            userId: context.ownerUserId,
            payerUserId: context.payerUserId,
            operation: context.operation,
            provider: context.provider,
            model: context.model,
            inputTokens,
            outputTokens,
            audioSeconds:
                audioSeconds === null ? null : audioSeconds.toFixed(3),
            costUsd: cost === null ? null : cost.toFixed(9),
            priceSource: source,
        });
    } catch (error) {
        console.error("Failed to record AI usage:", error);
    }
}

/** Read usage from an OpenAI-compatible chat response. */
export async function recordChatCompletionUsage(
    context: AiUsageContext,
    response: ChatCompletion,
): Promise<void> {
    const usage = response.usage;
    const extended = usage as (typeof usage & { cost?: number }) | undefined;
    await recordAiUsage(context, {
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        reportedCostUsd: extended?.cost,
    });
}

/** Count only spend paid by this account, including previous artefact runs. */
export async function recordingAiCost(
    recordingId: string,
    payerUserId: string,
) {
    const rows = await db
        .select({
            operation: aiUsageEvents.operation,
            provider: aiUsageEvents.provider,
            model: aiUsageEvents.model,
            costUsd: aiUsageEvents.costUsd,
        })
        .from(aiUsageEvents)
        .where(
            and(
                eq(aiUsageEvents.itemId, recordingId),
                eq(aiUsageEvents.payerUserId, payerUserId),
            ),
        );
    const byOperation: Record<string, number> = {};
    const byService: Record<string, number> = {};
    const unknownByService: Record<string, number> = {};
    let totalUsd = 0;
    let unknownCount = 0;
    for (const row of rows) {
        const service = `${row.provider} · ${row.model}`;
        if (row.costUsd === null) {
            unknownCount += 1;
            unknownByService[service] = (unknownByService[service] ?? 0) + 1;
            continue;
        }
        const amount = Number(row.costUsd);
        totalUsd += amount;
        byOperation[row.operation] = (byOperation[row.operation] ?? 0) + amount;
        byService[service] = (byService[service] ?? 0) + amount;
    }
    return {
        totalUsd,
        byOperation,
        byService,
        unknownByService,
        unknownCount,
        requestCount: rows.length,
    };
}
