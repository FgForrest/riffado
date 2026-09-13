import { describe, expect, it } from "vitest";
// Plain ESM sidecar module. `allowJs` infers its signatures, so this
// needs no declaration file.
import {
    buildArgs,
    buildPrompt,
    chatCompletion,
    contentToText,
    extractJson,
    parseClaudeEnvelope,
    resolveBackend,
    splitArgs,
} from "../../../agent-bridge/lib.mjs";

/**
 * Pure logic of the agent-bridge sidecar (`agent-bridge/`). CI has no
 * Claude or Codex subscription, so nothing here drives a real CLI --
 * `agent-bridge/smoke.sh` covers that against a running container. What
 * IS covered here is every decision the bridge makes about a request
 * before it spawns anything, which is where the Riffado-specific
 * assumptions live.
 */
describe("agent-bridge", () => {
    describe("resolveBackend", () => {
        it("routes claude ids to the Claude Code CLI", () => {
            expect(resolveBackend("claude-sonnet-5")).toBe("claude");
            expect(resolveBackend("claude-opus-5")).toBe("claude");
            expect(resolveBackend("claude-haiku-4-5-20251001")).toBe("claude");
        });

        it("routes codex and gpt-5 ids to the Codex CLI", () => {
            expect(resolveBackend("codex")).toBe("codex");
            expect(resolveBackend("gpt-5-codex")).toBe("codex");
        });

        it("refuses Riffado's gpt-4o-mini fallback rather than guessing", () => {
            // `generate-summary.ts` substitutes "gpt-4o-mini" when a
            // credential has no defaultModel. Routing that to Codex would
            // be a confusing way to discover the field was left blank, so
            // the bridge returns no backend and the caller 400s.
            expect(resolveBackend("gpt-4o-mini")).toBeNull();
            expect(resolveBackend("")).toBeNull();
            expect(resolveBackend(undefined)).toBeNull();
        });
    });

    describe("buildPrompt", () => {
        const system = { role: "system", content: "Respond with JSON only." };

        it("emits a lone user message verbatim under the system text", () => {
            // Riffado always sends exactly this shape. No role labels --
            // prefixing "user:" would put a token in front of the
            // transcript that the prompt never asked for.
            expect(
                buildPrompt([system, { role: "user", content: "the talk" }]),
            ).toBe("Respond with JSON only.\n\nthe talk");
        });

        it("labels roles once a conversation has more than one turn", () => {
            const prompt = buildPrompt([
                { role: "user", content: "a" },
                { role: "assistant", content: "b" },
            ]);
            expect(prompt).toBe("user: a\n\nassistant: b");
        });

        it("flattens array content parts", () => {
            expect(
                buildPrompt([
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "one" },
                            { type: "text", text: "two" },
                        ],
                    },
                ]),
            ).toBe("one\ntwo");
        });

        it("survives a missing or malformed messages array", () => {
            expect(buildPrompt(undefined)).toBe("");
            expect(buildPrompt([])).toBe("");
            expect(buildPrompt([system])).toBe("Respond with JSON only.");
        });
    });

    describe("contentToText", () => {
        it("passes strings through and ignores non-text parts", () => {
            expect(contentToText("plain")).toBe("plain");
            expect(
                contentToText([
                    { type: "text", text: "kept" },
                    { type: "image_url", image_url: { url: "x" } },
                ]),
            ).toBe("kept");
            expect(contentToText(null)).toBe("");
        });
    });

    describe("extractJson", () => {
        // The failure this exists for: Riffado's own fence-stripping in
        // `generate-summary.ts` is anchored to the very start and end of
        // the string, so a single sentence of preamble defeats it and the
        // whole reply lands in the summary field with empty keyPoints.
        const payload = '{"summary":"s","keyPoints":[],"actionItems":[]}';
        // A literal triple-backtick inside a template needs escaping that
        // obscures what is being tested; naming it keeps the cases legible.
        const FENCE = "```";

        it("returns bare JSON untouched", () => {
            expect(extractJson(payload)).toBe(payload);
            expect(extractJson(`  ${payload}  `)).toBe(payload);
        });

        it("unwraps a fenced block", () => {
            expect(extractJson(`${FENCE}json\n${payload}\n${FENCE}`)).toBe(
                payload,
            );
            expect(extractJson(`${FENCE}\n${payload}\n${FENCE}`)).toBe(payload);
        });

        it("strips agent preamble around a fenced block", () => {
            expect(
                extractJson(
                    `Sure! Here's the summary:\n\n${FENCE}json\n${payload}\n${FENCE}`,
                ),
            ).toBe(payload);
        });

        it("strips preamble around an unfenced object", () => {
            expect(extractJson(`Here you go: ${payload}`)).toBe(payload);
        });

        it("leaves plain text alone, so titles still work", () => {
            // `generateTitleFromTranscription` wants a bare title. Any
            // narrowing applied here would corrupt it.
            expect(extractJson("Quarterly Planning Call")).toBe(
                "Quarterly Planning Call",
            );
            expect(extractJson("Budget {draft} review")).toBe(
                "Budget {draft} review",
            );
        });

        it("leaves a broken JSON-ish reply alone rather than half-parsing it", () => {
            const broken = 'Here: {"summary": unterminated';
            expect(extractJson(broken)).toBe(broken);
        });

        it("tolerates empty and non-string input", () => {
            expect(extractJson("")).toBe("");
            expect(extractJson(null)).toBeNull();
        });
    });

    describe("buildArgs", () => {
        it("never puts the prompt in argv", () => {
            // Linux caps one argv element at 128 KiB (MAX_ARG_STRLEN) and
            // rejects longer with E2BIG. Riffado buckets transcripts at
            // 50k+ chars as "very_long", so a long meeting crosses it.
            const claude = buildArgs("claude", "claude-sonnet-5");
            const codex = buildArgs("codex", "gpt-5-codex", [], "/tmp/out.txt");
            for (const arg of [...claude, ...codex]) {
                expect(arg.length).toBeLessThan(256);
            }
        });

        it("asks Claude for the JSON envelope and never uses --bare", () => {
            const args = buildArgs("claude", "claude-sonnet-5");
            expect(args).toContain("--print");
            expect(args.join(" ")).toContain("--output-format json");
            // --bare disables OAuth and demands ANTHROPIC_API_KEY, which
            // is the one thing this bridge exists to avoid.
            expect(args).not.toContain("--bare");
        });

        it("gives Codex a file to write its final message to", () => {
            const args = buildArgs("codex", "gpt-5-codex", [], "/tmp/out.txt");
            expect(args[0]).toBe("exec");
            expect(args).toContain("--output-last-message");
            expect(args).toContain("/tmp/out.txt");
            // Trailing "-" makes Codex read the prompt from stdin.
            expect(args.at(-1)).toBe("-");
        });

        it("appends extra args ahead of the stdin marker", () => {
            const args = buildArgs(
                "codex",
                "gpt-5-codex",
                ["--foo", "bar"],
                "/tmp/out.txt",
            );
            expect(args.at(-3)).toBe("--foo");
            expect(args.at(-2)).toBe("bar");
            expect(args.at(-1)).toBe("-");
        });
    });

    describe("splitArgs", () => {
        it("splits on whitespace and drops empties", () => {
            expect(splitArgs("--max-turns 1")).toEqual(["--max-turns", "1"]);
            expect(splitArgs("  ")).toEqual([]);
            expect(splitArgs(undefined)).toEqual([]);
        });
    });

    describe("parseClaudeEnvelope", () => {
        it("returns the result field", () => {
            expect(
                parseClaudeEnvelope(
                    JSON.stringify({ type: "result", result: "hello" }),
                ),
            ).toBe("hello");
        });

        it("raises on an error envelope, unparseable output, or an empty result", () => {
            expect(() =>
                parseClaudeEnvelope(
                    JSON.stringify({ is_error: true, subtype: "boom" }),
                ),
            ).toThrow(/boom/);
            expect(() => parseClaudeEnvelope("not json")).toThrow(
                /JSON envelope/,
            );
            expect(() =>
                parseClaudeEnvelope(JSON.stringify({ result: "   " })),
            ).toThrow(/empty result/);
        });
    });

    describe("chatCompletion", () => {
        it("shapes a reply the openai SDK can read", () => {
            const body = chatCompletion(
                "claude-sonnet-5",
                '```json\n{"summary":"s"}\n```',
                "abc",
                1_700_000_000_000,
            );

            // This is the exact access path in generate-summary.ts.
            expect(body.choices[0].message.content).toBe('{"summary":"s"}');
            expect(body.choices[0].message.role).toBe("assistant");
            expect(body.choices[0].finish_reason).toBe("stop");
            expect(body.object).toBe("chat.completion");
            expect(body.model).toBe("claude-sonnet-5");
            expect(body.created).toBe(1_700_000_000);
        });

        it("reports zero usage rather than inventing counts", () => {
            const body = chatCompletion("claude-sonnet-5", "hi", "abc");
            expect(body.usage).toEqual({
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            });
        });
    });
});
