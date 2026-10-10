/** The client roles that grant areas of the external MCP server. */
export const MCP_ROLES = [
    "knowledge:read",
    "transcripts:read",
    "summaries:read",
    "tasks:read",
    "tasks:write",
    "mail:read",
] as const;

/** One of {@link MCP_ROLES}. */
export type McpRole = (typeof MCP_ROLES)[number];

const KNOWN = new Set<string>(MCP_ROLES);

function isMcpRole(value: unknown): value is McpRole {
    return typeof value === "string" && KNOWN.has(value);
}

function ownProperty(value: unknown, key: string): unknown {
    return typeof value === "object" &&
        value !== null &&
        Object.hasOwn(value, key)
        ? (value as Record<string, unknown>)[key]
        : undefined;
}

/**
 * The MCP roles a token grants: the roles of the `audience` client under
 * `resource_access` that Riffado knows. `tasks:write` counts only
 * alongside `tasks:read`.
 */
export function rolesFromPayload(
    payload: Record<string, unknown>,
    audience: string,
): Set<McpRole> {
    const client = ownProperty(payload.resource_access, audience);
    const raw = ownProperty(client, "roles");
    const roles = new Set<McpRole>();
    if (!Array.isArray(raw)) return roles;
    for (const role of raw) {
        if (isMcpRole(role)) roles.add(role);
    }
    if (!roles.has("tasks:read")) roles.delete("tasks:write");
    return roles;
}
