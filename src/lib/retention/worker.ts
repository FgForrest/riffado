import {
    listArmedRetentionPolicies,
    listReapCandidates,
    type RetentionPolicy,
} from "@/db/queries/retention";
import { captureServerException } from "@/lib/posthog-server";
import { createStorageProvider } from "@/lib/storage/factory";
import { reapRecording } from "./reap";

// Retention is measured in days; sweeping hourly is already far finer
// than the setting's own resolution. A tighter tick would only spend
// queries to delete the same rows a few minutes earlier.
const TICK_MS = 60 * 60 * 1000;

// Per-tick ceilings. Retention deletes data, so it is deliberately the
// least aggressive worker in the process: a first sweep over a large,
// long-neglected library spreads over several ticks instead of issuing
// thousands of storage deletes in one burst next to live transcription
// and sync work. Nothing is lost by going slowly -- the recordings are
// already past their retention period and will still be there next hour.
const MAX_USERS_PER_TICK = 25;
const MAX_RECORDINGS_PER_USER_PER_TICK = 50;

let started = false;
let running = false;

async function sweepUser(
    storage: ReturnType<typeof createStorageProvider>,
    policy: RetentionPolicy,
): Promise<void> {
    const now = new Date();
    const candidates = await listReapCandidates(
        policy,
        now,
        MAX_RECORDINGS_PER_USER_PER_TICK,
    );
    if (candidates.length === 0) return;

    const totals = {
        remoteOriginal: 0,
        audio: 0,
        transcript: 0,
        summary: 0,
    };
    let failures = 0;

    for (const candidate of candidates) {
        try {
            const { reaped, failed } = await reapRecording(
                storage,
                policy,
                candidate,
                now,
            );
            for (const kind of reaped) totals[kind] += 1;
            for (const [kind, error] of Object.entries(failed)) {
                failures += 1;
                console.error(
                    `[retention] failed to reap ${kind} for recording ${candidate.id}:`,
                    error,
                );
            }
        } catch (error) {
            // One unreadable blob or locked row must not strand the rest
            // of the sweep. The recording keeps its null marker, so the
            // next tick picks it up again.
            failures += 1;
            console.error(
                `[retention] failed to reap recording ${candidate.id}:`,
                error,
            );
        }
    }

    const removed =
        totals.remoteOriginal +
        totals.audio +
        totals.transcript +
        totals.summary;
    if (removed > 0 || failures > 0) {
        console.log(
            `[retention] user ${policy.userId}: removed ${totals.remoteOriginal} remote original(s), ${totals.audio} local audio, ${totals.transcript} transcript(s), ${totals.summary} summary(ies)` +
                (failures > 0 ? `; ${failures} failed, will retry` : ""),
        );
    }
}

async function tick(): Promise<void> {
    // A sweep that outlives its interval must not have a second one
    // started on top of it: two workers reaping the same candidate list
    // would race on the same storage deletes for no benefit.
    if (running) return;
    running = true;

    try {
        const policies = await listArmedRetentionPolicies(MAX_USERS_PER_TICK);
        if (policies.length === 0) return;

        const storage = createStorageProvider();
        for (const policy of policies) {
            try {
                await sweepUser(storage, policy);
            } catch (error) {
                console.error(
                    `[retention] sweep failed for user ${policy.userId}:`,
                    error,
                );
                captureServerException(error, {
                    source: "retention-worker",
                    userId: policy.userId,
                });
            }
        }
    } catch (error) {
        console.error("[retention] tick failed:", error);
        captureServerException(error, { source: "retention-worker" });
    } finally {
        running = false;
    }
}

/**
 * Start the retention sweep. Runs on hosted and self-host alike, and
 * no-ops for every user who has not explicitly selected something to
 * delete (see `listArmedRetentionPolicies`). Safe to call more than once.
 */
export function startRetentionWorker(): void {
    if (started) return;
    started = true;
    const interval = setInterval(() => {
        void tick();
    }, TICK_MS);
    interval.unref?.();
    void tick();
}
