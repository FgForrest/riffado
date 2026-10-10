/**
 * Running a correction pass (job kind `learn.correct`, queued when a Learn
 * run finishes, `correction-pass-queue.ts`): the Learn model reads the
 * whole transcript with the Almanac (`correction-pass.ts`), and the fixes
 * that hold are written at once as corrections of kind `fix`, each one
 * undone on its own like any correction. The provider is the actor's, who
 * pays, as for Learn.
 *
 * The pass goes nowhere when the transcript changed since the run read it
 * (superseded) or the actor may no longer change the recording in its
 * view (cancelled); both are checked again under the transcript lock
 * where the fixes are written. Whatever it ends with, it releases what
 * automatic Learn held back, and a summary the fixes made stale is made
 * again.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    transcriptCorrectionPasses,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { isRetryableError } from "@/lib/jobs/retryable";
import {
    InvalidJobPayloadError,
    type JobHandler,
    type JobResult,
} from "@/lib/jobs/types";
import { resolveTargetInTx } from "@/lib/knowledge/aliases";
import { anchorMatches } from "@/lib/knowledge/correction-anchors";
import { listCorrections } from "@/lib/knowledge/corrections";
import { knowledgeView } from "@/lib/knowledge/knowledge-loader";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { lockOrgPeopleShared } from "@/lib/knowledge/org-people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { lockTranscriptForChange } from "@/lib/knowledge/transcript-lock";
import { releaseAutoLearnHold } from "@/lib/learn/auto-learn";
import { learnChatClients } from "@/lib/learn/chat-clients";
import {
    type AlmanacRecord,
    planFixes,
    runCorrectionPass,
    type StandingCorrection,
} from "@/lib/learn/correction-pass";
import {
    LEARN_CORRECT_JOB_KIND,
    LEARN_CORRECT_MAX_ATTEMPTS,
} from "@/lib/learn/correction-pass-queue";
import { isFinalLearnError } from "@/lib/learn/errors";
import { mayStillRun } from "@/lib/learn/learn-job-handler";
import { chooseLearnPath } from "@/lib/learn/provider";
import { issueCorrectionPassToken } from "@/lib/learn/run-token";
import { refreshSummaryAfterCorrections } from "@/lib/learn/summary-refresh";
import { sharingOrgUserId } from "@/lib/sharing/writer";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

/** The Almanac records one pass is told of; the bridge looks up others. */
export const MAX_ALMANAC_RECORDS = 500;
const HEARD_DOMAIN = "correction-heard";

type PassRow = typeof transcriptCorrectionPasses.$inferSelect;
type PassStatus = PassRow["status"];

export interface CorrectionPassPayload {
    passId: string;
}

/** Leave the pass this attempt claimed, only while it is still `running`. */
async function setStatus(
    passId: string,
    status: PassStatus,
    extra: Partial<typeof transcriptCorrectionPasses.$inferInsert> = {},
): Promise<void> {
    await db
        .update(transcriptCorrectionPasses)
        .set({ status, updatedAt: new Date(), ...extra })
        .where(
            and(
                eq(transcriptCorrectionPasses.id, passId),
                eq(transcriptCorrectionPasses.status, "running"),
            ),
        );
}

/**
 * The Almanac records a pass is told of, at most `limit`: those this
 * transcript names (speakers, corrections) first, then those transcription
 * misheard before, then by name.
 */
export function almanacRecordsFor(
    items: Awaited<ReturnType<typeof knowledgeView>>["items"],
    named: ReadonlySet<string>,
    limit = MAX_ALMANAC_RECORDS,
): AlmanacRecord[] {
    const records = items.map((item) => ({
        id: item.id,
        kind: item.kind,
        typeKey: item.typeKey,
        name: item.name,
        aliases: [
            ...new Set(
                item.names
                    .filter((name) => name.kind === "alias")
                    .map((name) => name.text),
            ),
        ],
        heardAs: [
            ...new Set(
                item.names
                    .filter((name) => name.kind === "heard_as")
                    .map((name) => name.text),
            ),
        ],
    }));
    return records
        .sort(
            (a, b) =>
                Number(named.has(b.id)) - Number(named.has(a.id)) ||
                Number(b.heardAs.length > 0) - Number(a.heardAs.length > 0) ||
                a.name.localeCompare(b.name) ||
                a.id.localeCompare(b.id),
        )
        .slice(0, limit);
}

async function runPass({
    payload,
    signal,
    reportProgress,
}: Parameters<JobHandler<CorrectionPassPayload>["run"]>[0]): Promise<
    JobResult & { written: number; pass: PassRow | null }
> {
    const [pass] = await db
        .select()
        .from(transcriptCorrectionPasses)
        .where(eq(transcriptCorrectionPasses.id, payload.passId));
    if (!pass) return { skipped: "gone", written: 0, pass: null };
    if (pass.status !== "queued" && pass.status !== "running") {
        return { skipped: pass.status, written: 0, pass };
    }
    const claimed = await db
        .update(transcriptCorrectionPasses)
        .set({
            status: "running",
            startedAt: new Date(),
            updatedAt: new Date(),
            // Each attempt looks things up afresh.
            stats: sql`coalesce(${transcriptCorrectionPasses.stats}, '{}'::jsonb) - 'tool_calls'`,
        })
        .where(
            and(
                eq(transcriptCorrectionPasses.id, pass.id),
                inArray(transcriptCorrectionPasses.status, [
                    "queued",
                    "running",
                ]),
            ),
        )
        .returning({ id: transcriptCorrectionPasses.id });
    if (claimed.length === 0) return { skipped: "claimed", written: 0, pass };

    try {
        const [transcript] = await db
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.id, pass.transcriptionId));
        if (!transcript) {
            await setStatus(pass.id, "cancelled");
            return { skipped: "gone", written: 0, pass };
        }
        if (transcript.revision !== pass.transcriptRevision) {
            await setStatus(pass.id, "superseded");
            return { skipped: "superseded", written: 0, pass };
        }
        const orgUserId = await sharingOrgUserId();
        if (
            !(await mayStillRun(
                { ...pass, itemId: pass.recordingId },
                orgUserId,
            ))
        ) {
            await setStatus(pass.id, "cancelled");
            return { skipped: "not allowed", written: 0, pass };
        }
        const turns = readTranscriptTurns(transcript);
        if (!turns?.length) {
            await setStatus(pass.id, "cancelled");
            return { skipped: "untimed", written: 0, pass };
        }
        const shared = pass.view === "org";
        const view = await knowledgeView({
            kind: "recording",
            ownerUserId: pass.userId,
            shared,
        });
        const corrections = await listCorrections(
            pass.userId,
            pass.transcriptionId,
            db,
            { shared },
        );
        const speakers = await db
            .select({ personId: transcriptSpeakers.personId })
            .from(transcriptSpeakers)
            .where(
                eq(transcriptSpeakers.transcriptionId, pass.transcriptionId),
            );
        const named = new Set<string>();
        for (const row of speakers) if (row.personId) named.add(row.personId);
        for (const correction of corrections) {
            const target =
                correction.targetPersonId ?? correction.targetEntityId;
            if (target) named.add(target);
        }
        const almanac = almanacRecordsFor(view.items, named);
        // What already stands, as it reads: the pass leaves it be.
        const corrected: StandingCorrection[] = corrections
            .filter((correction) => anchorMatches(correction, turns))
            .map((correction) => ({
                turnIndex: correction.turnIndex,
                charStart: correction.charStart,
                charEnd: correction.charEnd,
                heard: correction.heard,
                reads:
                    correction.kind === "link"
                        ? correction.heard
                        : (correction.replacement ?? correction.heard),
            }));

        const actorUserId = pass.actorUserId ?? "";
        const { chat, bridge, provider, baseUrl, model } =
            await learnChatClients({
                actorUserId,
                recordingId: pass.recordingId,
                ownerUserId: pass.userId,
                operation: "correction",
                schemaName: "correction_output",
                signal,
            });
        const path = chooseLearnPath(
            { provider, baseUrl },
            { mcpUrl: env.LEARN_MCP_URL, bridgeUrl: env.LEARN_BRIDGE_URL },
        );
        reportProgress({ phase: "reading" });
        const result = await runCorrectionPass({
            path,
            bridge,
            chat,
            token: issueCorrectionPassToken(pass.id),
            turns,
            language: transcript.detectedLanguage,
            almanac,
            corrected,
            signal,
        });
        reportProgress({ phase: "writing" });

        const knownIds = new Set(view.items.map((item) => item.id));
        const outcome = await db.transaction(async (tx) => {
            await lockOrgPeopleShared(tx);
            const finish = (
                status: "finished" | "superseded" | "cancelled",
                stats: Record<string, number>,
            ) =>
                tx
                    .update(transcriptCorrectionPasses)
                    .set({
                        status,
                        path,
                        provider,
                        model,
                        // Merged: the MCP route counts its tool calls on
                        // the same row.
                        stats: sql`coalesce(${transcriptCorrectionPasses.stats}, '{}'::jsonb) || ${JSON.stringify(stats)}::jsonb`,
                        finishedAt: new Date(),
                        updatedAt: new Date(),
                    })
                    .where(eq(transcriptCorrectionPasses.id, pass.id));
            const baseStats = {
                calls: result.calls,
                windows: result.windows,
                repairs: result.repairs,
                proposed: result.fixes.length,
                ...(result.failedWindows > 0
                    ? { failed_windows: result.failedWindows }
                    : {}),
            };
            let locked: Awaited<ReturnType<typeof lockTranscriptForChange>>;
            try {
                locked = await lockTranscriptForChange(
                    tx,
                    {
                        userId: pass.userId,
                        transcriptionId: pass.transcriptionId,
                    },
                    { actorUserId, orgUserId },
                );
            } catch (error) {
                if (error instanceof AppError && error.statusCode < 500) {
                    await finish("cancelled", baseStats);
                    return { status: "cancelled" as const, written: 0 };
                }
                throw error;
            }
            // After the transcript, as a finishing review takes its run.
            const [still] = await tx
                .select({ status: transcriptCorrectionPasses.status })
                .from(transcriptCorrectionPasses)
                .where(eq(transcriptCorrectionPasses.id, pass.id))
                .for("update");
            if (still?.status !== "running") {
                return { status: "cancelled" as const, written: 0 };
            }
            if (locked.revision !== pass.transcriptRevision || !locked.turns) {
                await finish("superseded", baseStats);
                return { status: "superseded" as const, written: 0 };
            }
            // What stands now, in the scope the pass writes: never under it.
            const standing = await tx
                .select({
                    turnIndex: transcriptCorrections.turnIndex,
                    charStart: transcriptCorrections.charStart,
                    charEnd: transcriptCorrections.charEnd,
                })
                .from(transcriptCorrections)
                .where(
                    and(
                        eq(
                            transcriptCorrections.transcriptionId,
                            pass.transcriptionId,
                        ),
                        eq(transcriptCorrections.userId, actorUserId),
                    ),
                );
            const { planned, dropped } = planFixes(result.fixes, {
                turns: locked.turns,
                taken: standing,
                knownIds,
            });
            const rows = [];
            for (const fix of planned) {
                let target = fix.target;
                if (target) {
                    try {
                        target = await resolveTargetInTx(
                            tx,
                            actorUserId,
                            target,
                        );
                    } catch {
                        target = null;
                    }
                }
                rows.push({
                    userId: actorUserId,
                    transcriptionId: pass.transcriptionId,
                    transcriptRevision: locked.revision,
                    turnIndex: fix.turnIndex,
                    charStart: fix.charStart,
                    charEnd: fix.charEnd,
                    heard: encryptText(fix.heard),
                    heardHmac: domainLookupHash(HEARD_DOMAIN, fix.heard),
                    kind: "fix" as const,
                    targetPersonId:
                        target && "personId" in target ? target.personId : null,
                    targetEntityId:
                        target && "entityId" in target ? target.entityId : null,
                    replacement: encryptText(fix.replacement),
                    passId: pass.id,
                    createdByUserId: null,
                });
            }
            if (rows.length > 0) {
                await tx.insert(transcriptCorrections).values(rows);
                await bumpScopeInTx(tx, [actorUserId]);
            }
            await finish("finished", {
                ...baseStats,
                written: rows.length,
                ...Object.fromEntries(
                    Object.entries(dropped).map(([reason, count]) => [
                        `dropped_${reason}`,
                        count ?? 0,
                    ]),
                ),
            });
            return { status: "finished" as const, written: rows.length };
        });
        return { ...outcome, pass };
    } catch (caught) {
        // Final as for Learn (no usable answer, lookups spent): no retry.
        const error = isFinalLearnError(caught)
            ? new AppError(
                  ErrorCode.AI_PROVIDER_API_ERROR,
                  caught instanceof Error
                      ? caught.message
                      : "The correction pass failed",
                  502,
              )
            : caught;
        throw error;
    }
}

export const correctionPassJobHandler: JobHandler<CorrectionPassPayload> = {
    kind: LEARN_CORRECT_JOB_KIND,
    // One at a time: it goes to the same providers as Learn and summaries.
    concurrency: 1,
    maxAttempts: LEARN_CORRECT_MAX_ATTEMPTS,
    timeoutMs: 20 * 60 * 1000,
    backoff: { baseMs: 30_000, maxMs: 10 * 60_000, jitter: 0.3 },
    parsePayload(raw) {
        if (typeof raw.passId !== "string" || !raw.passId) {
            throw new InvalidJobPayloadError(LEARN_CORRECT_JOB_KIND, "passId");
        }
        return { passId: raw.passId };
    },

    async run(context): Promise<JobResult> {
        let ended: PassRow | null = null;
        let written = 0;
        try {
            const { pass, written: count, ...result } = await runPass(context);
            ended = pass;
            written = count;
            return { ...result, written: count };
        } catch (caught) {
            const retrying =
                context.attempt < context.maxAttempts &&
                isRetryableError(caught);
            await setStatus(
                context.payload.passId,
                retrying ? "queued" : "failed",
                retrying
                    ? {}
                    : {
                          errorCode:
                              caught instanceof AppError
                                  ? caught.code
                                  : ErrorCode.INTERNAL_ERROR,
                          finishedAt: new Date(),
                      },
            ).catch(() => undefined);
            if (!retrying) {
                const [pass] = await db
                    .select()
                    .from(transcriptCorrectionPasses)
                    .where(
                        eq(
                            transcriptCorrectionPasses.id,
                            context.payload.passId,
                        ),
                    )
                    .catch(() => []);
                ended = pass ?? null;
            }
            throw caught;
        } finally {
            if (ended) await afterPass(ended, written, context.jobId);
        }
    },
};

/**
 * What a pass that ended leaves to do: release what automatic Learn held
 * back (made then from the corrected transcript), else make again a
 * summary its fixes made stale.
 */
async function afterPass(
    pass: PassRow,
    written: number,
    jobId: string,
): Promise<void> {
    try {
        const released =
            pass.view === "private"
                ? await releaseAutoLearnHold(pass.recordingId, {
                      exceptJobId: jobId,
                  })
                : false;
        if (!released && written > 0) {
            await refreshSummaryAfterCorrections({
                ownerUserId: pass.userId,
                recordingId: pass.recordingId,
                view: pass.view,
            });
        }
    } catch (error) {
        console.error(
            `After the correction pass on recording ${pass.recordingId}:`,
            error,
        );
    }
}
