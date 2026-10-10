-- Every recording becomes an item of the Chatter pile with the same id.
-- The columns that moved to the item are copied verbatim (the title stays
-- encrypted as it was); they stay on `recordings`, frozen, until their drop
-- (src/db/deprecated-columns.ts). Idempotent, so a rerun after a partial
-- apply copies only what is missing.
INSERT INTO "chatter_items" (
    "id",
    "user_id",
    "kind",
    "title",
    "title_edited_at",
    "occurred_at",
    "deleted_at",
    "summary_due_at",
    "content_reaped_at",
    "summary_reaped_at",
    "created_at",
    "updated_at"
)
SELECT
    "id",
    "user_id",
    'audio',
    "filename",
    "title_edited_at",
    "start_time",
    "deleted_at",
    "summary_due_at",
    "transcript_reaped_at",
    "summary_reaped_at",
    "created_at",
    "updated_at"
FROM "recordings"
ON CONFLICT ("id") DO NOTHING;
