import type { McpToolDef } from "@/lib/mcp/registry";
import { KNOWLEDGE_TOOLS } from "@/lib/mcp/tools/knowledge";
import { MAIL_TOOLS } from "@/lib/mcp/tools/mail";
import { RECORDING_TOOLS } from "@/lib/mcp/tools/recordings";
import { SUMMARY_TOOLS } from "@/lib/mcp/tools/summaries";
import { TASK_TOOLS } from "@/lib/mcp/tools/tasks";
import { TRANSCRIPT_TOOLS } from "@/lib/mcp/tools/transcripts";

/** Every tool of the external MCP server, in listing order. */
export const ALL_TOOLS: readonly McpToolDef[] = [
    ...KNOWLEDGE_TOOLS,
    ...RECORDING_TOOLS,
    ...TRANSCRIPT_TOOLS,
    ...SUMMARY_TOOLS,
    ...TASK_TOOLS,
    ...MAIL_TOOLS,
];
