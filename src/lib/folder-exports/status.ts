import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { folderExportConfigurations } from "@/db/schema";
import { isExportErrorRetryable } from "./retry";

/**
 * Remembers a failure on the export itself when only the user can fix it,
 * so the export dialog can say why nothing arrives. Transient failures are
 * retried and not shown.
 */
export async function recordExportFailure(
    userId: string,
    exportId: string,
    error: unknown,
): Promise<void> {
    if (isExportErrorRetryable(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    await db
        .update(folderExportConfigurations)
        .set({ lastError: message.slice(0, 2000), lastErrorAt: new Date() })
        .where(
            and(
                eq(folderExportConfigurations.id, exportId),
                eq(folderExportConfigurations.userId, userId),
            ),
        );
}

export async function clearExportFailure(
    userId: string,
    exportId: string,
): Promise<void> {
    await db
        .update(folderExportConfigurations)
        .set({ lastError: null, lastErrorAt: null })
        .where(
            and(
                eq(folderExportConfigurations.id, exportId),
                eq(folderExportConfigurations.userId, userId),
                isNotNull(folderExportConfigurations.lastError),
            ),
        );
}
