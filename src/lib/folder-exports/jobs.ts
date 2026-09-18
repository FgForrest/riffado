import { eq } from "drizzle-orm";
import { db } from "@/db";
import { type EnqueueJobResult, enqueueJob } from "@/db/queries/async-jobs";
import {
    folderExportConfigurations,
    folderExportMaterializations,
} from "@/db/schema";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError } from "@/lib/jobs/types";

export const EXPORT_PLAN_JOB_KIND = "folder-export-plan";
export const EXPORT_MATERIALIZE_JOB_KIND = "folder-export-materialize";
export const EXPORT_RECONCILE_JOB_KIND = "folder-export-reconcile";

function parseId(
    kind: string,
    raw: Record<string, unknown>,
    key: string,
): string {
    const value = raw[key];
    if (typeof value !== "string" || !value) {
        throw new InvalidJobPayloadError(
            kind,
            `${key} must be a non-empty string`,
        );
    }
    return value;
}

export interface ExportPlanPayload {
    exportId: string;
}

export function parseExportPlanPayload(
    raw: Record<string, unknown>,
): ExportPlanPayload {
    return { exportId: parseId(EXPORT_PLAN_JOB_KIND, raw, "exportId") };
}

export interface ExportMaterializePayload {
    materializationId: string;
}

export function parseExportMaterializePayload(
    raw: Record<string, unknown>,
): ExportMaterializePayload {
    return {
        materializationId: parseId(
            EXPORT_MATERIALIZE_JOB_KIND,
            raw,
            "materializationId",
        ),
    };
}

export interface ExportReconcilePayload {
    folderId: string;
}

export function parseExportReconcilePayload(
    raw: Record<string, unknown>,
): ExportReconcilePayload {
    return { folderId: parseId(EXPORT_RECONCILE_JOB_KIND, raw, "folderId") };
}

async function queue(
    input: Parameters<typeof enqueueJob>[0],
): Promise<EnqueueJobResult> {
    const result = await enqueueJob(input);
    if (result.created) nudge();
    return result;
}

export function enqueueExportPlan(userId: string, exportId: string) {
    return queue({
        userId,
        kind: EXPORT_PLAN_JOB_KIND,
        subjectId: exportId,
        payload: { exportId },
        maxAttempts: 3,
    });
}

export async function enqueueExportPlansForUser(userId: string): Promise<void> {
    const configurations = await db
        .select({ id: folderExportConfigurations.id })
        .from(folderExportConfigurations)
        .where(eq(folderExportConfigurations.userId, userId));
    await Promise.all(
        configurations.map((configuration) =>
            enqueueExportPlan(userId, configuration.id),
        ),
    );
}

export function enqueueExportMaterialization(
    userId: string,
    materializationId: string,
) {
    return queue({
        userId,
        kind: EXPORT_MATERIALIZE_JOB_KIND,
        subjectId: materializationId,
        payload: { materializationId },
        maxAttempts: 5,
    });
}

export function enqueueExportReconciliation(userId: string, folderId: string) {
    return queue({
        userId,
        kind: EXPORT_RECONCILE_JOB_KIND,
        subjectId: `${userId}:${folderId}`,
        priority: 10,
        payload: { folderId },
        maxAttempts: 3,
    });
}

export async function seedPendingFolderExports(): Promise<number> {
    const [configurations, pending] = await Promise.all([
        db
            .select({
                id: folderExportConfigurations.id,
                userId: folderExportConfigurations.userId,
            })
            .from(folderExportConfigurations),
        db
            .select({
                id: folderExportMaterializations.id,
                userId: folderExportMaterializations.userId,
            })
            .from(folderExportMaterializations)
            .where(eq(folderExportMaterializations.status, "pending")),
    ]);
    let queued = 0;
    for (const configuration of configurations) {
        const result = await enqueueExportPlan(
            configuration.userId,
            configuration.id,
        );
        if (result.created) queued += 1;
    }
    for (const state of pending) {
        const result = await enqueueExportMaterialization(
            state.userId,
            state.id,
        );
        if (result.created) queued += 1;
    }
    return queued;
}

let seederStarted = false;

export function startFolderExportSeeder(): void {
    if (seederStarted) return;
    seederStarted = true;
    void seedPendingFolderExports().catch((error) => {
        console.error("[folder-export] failed to seed pending work:", error);
    });
}

export function __resetFolderExportSeederForTests(): void {
    seederStarted = false;
}
