/**
 * A column kept in the schema after the code stopped using it, waiting for
 * its drop. Its schema property is named `deprecated<Name>`, and nothing
 * outside `src/db/` may use it.
 */
export interface DeprecatedColumn {
    /** SQL table name. */
    table: string;
    /** SQL column name. */
    column: string;
    /** Why it is still there, and where its data lives now. */
    why: string;
    /**
     * ISO date after which `src/tests/db/deprecated-columns.test.ts` fails
     * while the column is still in the schema. Moved only by editing this
     * entry in a reviewed change.
     */
    dropAfter: string;
    /** GitHub issue tracking the drop, once opened. */
    issue: number | null;
}

/**
 * Every deprecated column. Dropping one: remove it from `schema.ts`, run
 * `pnpm db:generate` (a pure removal, no prompt), delete its entry here and
 * close its issue.
 */
export const DEPRECATED_COLUMNS: readonly DeprecatedColumn[] = [
    ...(
        [
            ["filename", "chatter_items.title"],
            ["start_time", "chatter_items.occurred_at"],
            ["title_edited_at", "chatter_items.title_edited_at"],
            ["summary_due_at", "chatter_items.summary_due_at"],
            ["transcript_reaped_at", "chatter_items.content_reaped_at"],
            ["summary_reaped_at", "chatter_items.summary_reaped_at"],
        ] as const
    ).map(([column, now]) => ({
        table: "recordings",
        column,
        why: `Moved to ${now} (migration 0096 copied it); frozen since, kept to recover from a bad copy.`,
        dropAfter: "2026-11-15",
        issue: null,
    })),
    {
        table: "recordings",
        column: "unshared_at",
        why: "Timed a grace period that no longer exists; never read or written since 2026-09-28.",
        dropAfter: "2026-11-15",
        issue: null,
    },
];
