/**
 * Helpers for asserting what a Drizzle `where` expression actually contains.
 *
 * A db mock answers every query the same way, so `expect(rows).toEqual([])`
 * still passes after the ownership filter is deleted. Inspecting the
 * expression the query was built with is what makes such a test fail.
 */

/** The keys Drizzle composes expression trees out of. */
const BRANCH_KEYS = [
    "queryChunks",
    "sql",
    "left",
    "right",
    "value",
    "args",
    "chunks",
    "expr",
] as const;

/**
 * Whether `col` appears anywhere in a Drizzle SQL/expression tree.
 *
 * `and(eq(a, b), ...)` composes into nested objects holding `queryChunks`,
 * `left`, `right` and friends, so the tree is walked over the common shapes
 * rather than matched against one of them.
 */
export function exprReferencesColumn(
    expr: unknown,
    col: unknown,
    seen = new Set<unknown>(),
): boolean {
    if (expr == null || typeof expr !== "object") return false;
    if (expr === col) return true;
    if (seen.has(expr)) return false;
    seen.add(expr);
    for (const key of BRANCH_KEYS) {
        const value = (expr as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
            if (value.some((item) => exprReferencesColumn(item, col, seen))) {
                return true;
            }
        } else if (exprReferencesColumn(value, col, seen)) {
            return true;
        }
    }
    return false;
}

/**
 * Whether a primitive `literal` is bound anywhere in the expression tree.
 *
 * Drizzle wraps a bound value in a param object, so the literal sits a level
 * or two below the comparison that carries it.
 */
export function exprBindsValue(
    expr: unknown,
    literal: string | number | boolean | null,
    seen = new Set<unknown>(),
): boolean {
    if (expr === literal) return true;
    if (expr == null || typeof expr !== "object") return false;
    if (seen.has(expr)) return false;
    seen.add(expr);
    for (const key of BRANCH_KEYS) {
        const value = (expr as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
            if (value.some((item) => exprBindsValue(item, literal, seen))) {
                return true;
            }
        } else if (exprBindsValue(value, literal, seen)) {
            return true;
        }
    }
    return false;
}
