import { sql } from "drizzle-orm";
import { type people, users } from "@/db/schema";

/**
 * SQL predicate: the row belongs to the organization account.
 *
 * By role rather than by a configured id, so knowledge code needs neither
 * the environment nor the org account's id, and an Organization person
 * keeps resolving if the scope is later switched off.
 */
export function orgOwnedCondition(column: typeof people.userId) {
    return sql`${column} in (select ${users.id} from ${users} where ${users.role} = 'org')`;
}
