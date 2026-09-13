/**
 * Pure request/response logic for the agent-bridge sidecar.
 *
 * Split from `server.mjs` so it can be imported and tested without
 * binding a port, spawning a CLI, or needing a subscription -- see
 * `src/tests/ai/agent-bridge.test.ts`. Nothing here touches I/O.
 */

export class BridgeError extends Error {
    constructor(status, message) {
        super(message);
        this.name = "BridgeError";
        this.status = status;
    }
}

/** Split a space-separated env var into argv entries. */
export function splitArgs(value) {
    return (value || "").trim().split(/\s+/).filter(Boolean);
}

/**
 * One sidecar serves both CLIs, so the `model` field is what picks the
 * backend. Returns "claude", "codex", or null.
 *
 * An unrecognised id is a hard error upstream rather than a guess:
 * Riffado falls back to `gpt-4o-mini` when a credential has no
 * `defaultModel` (`generate-summary.ts`), and silently routing that to
 * Codex would be a confusing way to discover the model field was left
 * blank.
 */
export function resolveBackend(model) {
    if (typeof model !== "string") return null;
    const id = model.trim();
    if (id.startsWith("claude")) return "claude";
    if (id.startsWith("codex") || id.startsWith("gpt-5")) return "codex";
    return null;
}

/** OpenAI message content is a string or an array of typed parts. */
export function contentToText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part) => {
            if (typeof part === "string") return part;
            return typeof part?.text === "string" ? part.text : "";
        })
        .filter(Boolean)
        .join("\n");
}

/**
 * Flatten `messages` into the single prompt a CLI turn accepts.
 *
 * System content is prepended as plain text rather than passed through a
 * `--append-system-prompt`-style flag: it behaves identically for both
 * backends and keeps one more per-CLI flag off the critical path.
 *
 * Riffado only ever sends one system + one user message, which is why
 * that case emits the user text verbatim -- adding a "user:" label would
 * put a token in front of the transcript that the prompt never asked for.
 */
export function buildPrompt(messages) {
    if (!Array.isArray(messages)) return "";

    const system = messages
        .filter((m) => m?.role === "system")
        .map((m) => contentToText(m.content))
        .filter(Boolean)
        .join("\n\n");

    const rest = messages.filter((m) => m?.role && m.role !== "system");

    const body =
        rest.length === 1 && rest[0].role === "user"
            ? contentToText(rest[0].content)
            : rest
                  .map((m) => `${m.role}: ${contentToText(m.content)}`)
                  .filter((line) => !line.endsWith(": "))
                  .join("\n\n");

    if (!body) return system;
    return system ? `${system}\n\n${body}` : body;
}

function isJson(value) {
    try {
        JSON.parse(value);
        return true;
    } catch {
        return false;
    }
}

/**
 * Pull a JSON payload out of an agent's reply.
 *
 * Both CLIs front a coding agent, not a completions endpoint, so a reply
 * sometimes arrives wrapped in prose ("Here's the summary:") or a fenced
 * block. Riffado strips fences only at the very start and end of the
 * string (`generate-summary.ts`), so a leading sentence defeats it and
 * the entire reply -- preamble included -- gets stored as the summary
 * with empty keyPoints and actionItems.
 *
 * Strictly a narrowing step. Anything not recognisably JSON comes back
 * untouched, which is what keeps plain-text callers working:
 * `generateTitleFromTranscription` wants a bare title, not JSON.
 */
export function extractJson(text) {
    if (typeof text !== "string") return text;
    const trimmed = text.trim();
    if (!trimmed) return text;

    // Already bare JSON.
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && isJson(fenced[1].trim())) return fenced[1].trim();

    // Prose around a bare object, no fence.
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last > first) {
        const candidate = trimmed.slice(first, last + 1);
        if (isJson(candidate)) return candidate;
    }

    return text;
}

/**
 * Build the argv for a backend. The prompt is NOT included: it goes in on
 * stdin, because Linux caps a single argv element at MAX_ARG_STRLEN
 * (128 KiB) and rejects anything longer with E2BIG. Riffado buckets
 * transcripts at 50k+ chars as "very_long", so a long meeting crosses
 * that line and would fail to spawn at all. It also keeps the transcript
 * out of `ps` output.
 */
export function buildArgs(backend, model, extraArgs = [], codexOutPath = "") {
    if (backend === "claude") {
        // `--print`, never `--bare`: --bare disables OAuth and demands
        // ANTHROPIC_API_KEY, which is the one thing this bridge exists to
        // avoid.
        return [
            "--print",
            "--output-format",
            "json",
            "--model",
            model,
            ...extraArgs,
        ];
    }
    if (backend === "codex") {
        // `--output-last-message` writes just the final assistant message
        // to a file. Parsing `--json` JSONL instead would mean depending
        // on event shapes that move between releases; a file with one
        // string in it does not.
        return [
            "exec",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--output-last-message",
            codexOutPath,
            "--model",
            model,
            ...extraArgs,
            "-",
        ];
    }
    throw new BridgeError(400, `unknown backend "${backend}"`);
}

/** Shape a successful reply as an OpenAI chat completion. */
export function chatCompletion(model, content, id, createdMs = Date.now()) {
    return {
        id: `chatcmpl-${id}`,
        object: "chat.completion",
        created: Math.floor(createdMs / 1000),
        model,
        choices: [
            {
                index: 0,
                message: { role: "assistant", content: extractJson(content) },
                finish_reason: "stop",
            },
        ],
        // The CLIs bill against a subscription, not per token, and report
        // no usable per-request counts. Zeros keep the response shape
        // valid for clients that read it; they are not a measurement.
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}

/** Parse the `--output-format json` envelope from the Claude CLI. */
export function parseClaudeEnvelope(stdout, bin = "claude") {
    let envelope;
    try {
        envelope = JSON.parse(stdout);
    } catch {
        throw new BridgeError(
            502,
            `${bin} produced output that is not the expected JSON envelope`,
        );
    }

    if (envelope.is_error) {
        throw new BridgeError(
            502,
            `${bin} reported an error (subtype: ${envelope.subtype ?? "unknown"})`,
        );
    }

    const text = typeof envelope.result === "string" ? envelope.result : "";
    if (!text.trim()) {
        throw new BridgeError(502, `${bin} returned an empty result`);
    }
    return text;
}
