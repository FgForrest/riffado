import { sql } from "drizzle-orm";
import { db } from "@/db";
import { mailDeliveryLog } from "@/db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days a delivery log row is kept. */
export const MAIL_DELIVERY_LOG_RETENTION_DAYS = 30;

/** Deletes up to `limit` delivery log rows older than `olderThanDays`. */
export async function pruneMailDeliveryLog(
    olderThanDays: number,
    limit = 5_000,
): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * DAY_MS).toISOString();
    const rows = await db.execute<{ n: number }>(sql`
        with doomed as (
            select ${mailDeliveryLog.id} as id
            from ${mailDeliveryLog}
            where ${mailDeliveryLog.at} < ${cutoff}::timestamp
            limit ${limit}
        ), deleted as (
            delete from ${mailDeliveryLog}
            where ${mailDeliveryLog.id} in (select id from doomed)
            returning 1
        )
        select count(*)::int as n from deleted
    `);
    return Number(rows[0]?.n ?? 0);
}
