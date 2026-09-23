import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { driveExportNodes } from "@/db/schema";

export type DriveNodeKind = "folder" | "file" | "google_doc";

export interface DriveNode {
    logicalPath: string;
    driveFileId: string;
    kind: DriveNodeKind;
}

/** Where a Drive export remembers the ids of the items it created. */
export interface DriveNodeStore {
    get(logicalPath: string): Promise<DriveNode | null>;
    put(node: DriveNode): Promise<void>;
    /** Forgets `logicalPath` and everything beneath it. */
    removeSubtree(logicalPath: string): Promise<void>;
    /** Re-roots `previous` and everything beneath it at `current`. */
    movePrefix(previous: string, current: string): Promise<void>;
    /** Whether a file or Doc the export wrote lies beneath `logicalPath`. */
    hasFilesUnder(logicalPath: string): Promise<boolean>;
}

function underPrefix(logicalPath: string) {
    const prefix = `${logicalPath}/`;
    return sql`left(${driveExportNodes.logicalPath}, char_length(${prefix}::text)) = ${prefix}::text`;
}

export class DbDriveNodeStore implements DriveNodeStore {
    constructor(
        private readonly userId: string,
        private readonly exportId: string,
    ) {}

    private scope() {
        return and(
            eq(driveExportNodes.userId, this.userId),
            eq(driveExportNodes.exportConfigurationId, this.exportId),
        );
    }

    private subtree(logicalPath: string) {
        return and(
            this.scope(),
            or(
                eq(driveExportNodes.logicalPath, logicalPath),
                underPrefix(logicalPath),
            ),
        );
    }

    async get(logicalPath: string): Promise<DriveNode | null> {
        const [row] = await db
            .select({
                logicalPath: driveExportNodes.logicalPath,
                driveFileId: driveExportNodes.driveFileId,
                kind: driveExportNodes.kind,
            })
            .from(driveExportNodes)
            .where(
                and(
                    this.scope(),
                    eq(driveExportNodes.logicalPath, logicalPath),
                ),
            )
            .limit(1);
        return row ?? null;
    }

    async put(node: DriveNode): Promise<void> {
        await db
            .insert(driveExportNodes)
            .values({
                userId: this.userId,
                exportConfigurationId: this.exportId,
                ...node,
            })
            .onConflictDoUpdate({
                target: [
                    driveExportNodes.exportConfigurationId,
                    driveExportNodes.logicalPath,
                ],
                set: {
                    driveFileId: node.driveFileId,
                    kind: node.kind,
                    updatedAt: new Date(),
                },
            });
    }

    async removeSubtree(logicalPath: string): Promise<void> {
        await db.delete(driveExportNodes).where(this.subtree(logicalPath));
    }

    async movePrefix(previous: string, current: string): Promise<void> {
        await db
            .update(driveExportNodes)
            .set({
                logicalPath: sql`${current}::text || substr(${driveExportNodes.logicalPath}, char_length(${previous}::text) + 1)`,
                updatedAt: new Date(),
            })
            .where(this.subtree(previous));
    }

    async hasFilesUnder(logicalPath: string): Promise<boolean> {
        const [row] = await db
            .select({ id: driveExportNodes.id })
            .from(driveExportNodes)
            .where(
                and(
                    this.scope(),
                    underPrefix(logicalPath),
                    inArray(driveExportNodes.kind, ["file", "google_doc"]),
                ),
            )
            .limit(1);
        return Boolean(row);
    }
}
