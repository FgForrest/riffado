/**
 * Topics are anchored to the times in a transcript's turns, so every write
 * of a transcript's text or turns must also write its topics: as NULL for a
 * new transcript, or carried along for an identical copy. A writer that
 * leaves the column out would keep stale topics beside a transcript they no
 * longer describe.
 *
 * Checked over the source rather than by running each writer, so a writer
 * added later is covered without anyone remembering to add a test for it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            return name === "tests" ? [] : sourceFiles(path);
        }
        return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
    });
}

/** The `{...}` literal starting at `open`, braces balanced. */
function objectLiteral(source: string, open: number): string {
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === "{") depth++;
        if (source[i] === "}" && --depth === 0) {
            return source.slice(open, i + 1);
        }
    }
    return source.slice(open);
}

interface Write {
    file: string;
    fields: string;
}

function transcriptWrites(): Write[] {
    const writes: Write[] = [];
    for (const file of sourceFiles(SRC)) {
        const source = readFileSync(file, "utf8");
        const pattern = /\.(update|insert)\(transcriptions\)/g;
        for (const match of source.matchAll(pattern)) {
            const call = match[1] === "update" ? ".set(" : ".values(";
            const at = source.indexOf(call, match.index);
            const open = source.indexOf("{", at);
            if (at === -1 || open === -1) continue;
            writes.push({
                file: file.slice(SRC.length + 1),
                fields: objectLiteral(source, open),
            });
        }
    }
    return writes;
}

describe("transcript writers and topics", () => {
    const writes = transcriptWrites();

    it("finds the writers", () => {
        // persist.ts (update + insert), the browser path (update + insert),
        // the Organization copy, and the topics write itself.
        expect(writes.length).toBeGreaterThanOrEqual(6);
    });

    it("writes topics wherever it writes a transcript's text or turns", () => {
        const offenders = writes
            .filter((write) => /\b(text|turns):/.test(write.fields))
            // The property, not the word: a comment mentioning topics must
            // not count as writing them.
            .filter((write) => !/\btopics\s*[:,]/.test(write.fields))
            .map((write) => write.file);
        expect(offenders).toEqual([]);
    });
});
