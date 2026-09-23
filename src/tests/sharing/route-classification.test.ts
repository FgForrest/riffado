/**
 * Every recording route method is classified by who may call it.
 *
 * Sharing made "who owns this recording" and "who may act on it" two
 * different questions. A route added later that answers the old one -- a
 * bare `recordings.userId = session` filter -- is either harmless (owner
 * only) or a gap (a shared view that 404s, or worse, an owner-only action
 * that stops checking). This test does not decide which; it fails until
 * whoever adds a route has decided and written it down here.
 *
 *   - `owner`: the recording's owner only, by its own `userId` filter.
 *   - `access`: anyone who can see the recording (`requireRecordingAccess`).
 *   - `view`: gated per view (`requireRecordingView`); `?view=org` opens the
 *     Organization view to every account while the recording is shared.
 *   - `folders`: authorized per folder by `src/lib/folders/folders.ts`.
 *   - `job`: authorized per job by `getJobVisibleTo`.
 *   - `people`: the caller's own knowledge base.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

type Rule = "owner" | "access" | "view" | "folders" | "job" | "people";

const CLASSIFIED: Record<string, Record<string, Rule>> = {
    "recordings/[id]/route.ts": {
        GET: "owner",
        PATCH: "owner",
        DELETE: "owner",
    },
    "recordings/[id]/audio/route.ts": { GET: "access" },
    "recordings/[id]/peaks/route.ts": { POST: "access", PUT: "access" },
    "recordings/[id]/erase/route.ts": { POST: "owner" },
    "recordings/[id]/folders/route.ts": {
        POST: "folders",
        PATCH: "folders",
        DELETE: "folders",
    },
    "recordings/[id]/markdown/[kind]/route.ts": { GET: "view" },
    "recordings/[id]/speakers/route.ts": { GET: "view", PUT: "view" },
    "recordings/[id]/summary/route.ts": {
        GET: "view",
        POST: "view",
        DELETE: "view",
    },
    // Gated as `view`, and the private view is the only one it accepts:
    // topics are written onto the viewer's own transcript row.
    "recordings/[id]/topics/route.ts": { GET: "view", POST: "view" },
    "recordings/[id]/transcribe/route.ts": { GET: "view", POST: "view" },
    "recordings/[id]/transcription/from-browser/route.ts": { POST: "owner" },
    "jobs/[id]/route.ts": { GET: "job" },
    "folders/route.ts": { GET: "folders", POST: "folders" },
    "folders/[id]/route.ts": { PATCH: "folders", DELETE: "folders" },
    "folders/[id]/exports/route.ts": { GET: "owner", POST: "owner" },
    "folders/[id]/exports/[exportId]/route.ts": {
        PATCH: "owner",
        DELETE: "owner",
    },
    "folders/[id]/synchronize/route.ts": { POST: "owner" },
    "people/route.ts": { GET: "people", POST: "people" },
    "people/[id]/route.ts": {
        GET: "people",
        PATCH: "people",
        POST: "people",
        DELETE: "people",
    },
};

const API_ROOT = join(__dirname, "../../app/api");
const GUARDED_DIRECTORIES = ["recordings/[id]", "jobs", "folders", "people"];
const METHOD = /export const (GET|POST|PUT|PATCH|DELETE)\b/g;

function routeFiles(directory: string): string[] {
    const absolute = join(API_ROOT, directory);
    return readdirSync(absolute).flatMap((entry) => {
        const path = join(absolute, entry);
        if (statSync(path).isDirectory()) {
            return routeFiles(relative(API_ROOT, path));
        }
        return entry === "route.ts" ? [relative(API_ROOT, path)] : [];
    });
}

function exportedMethods(file: string): string[] {
    const source = readFileSync(join(API_ROOT, file), "utf8");
    return [...source.matchAll(METHOD)].map((match) => match[1]).sort();
}

describe("recording route classification", () => {
    const files = GUARDED_DIRECTORIES.flatMap(routeFiles).sort();

    it("classifies every method of every guarded route", () => {
        const found = Object.fromEntries(
            files.map((file) => [file, exportedMethods(file)]),
        );
        const classified = Object.fromEntries(
            Object.entries(CLASSIFIED).map(([file, methods]) => [
                file,
                Object.keys(methods).sort(),
            ]),
        );
        expect(found).toEqual(classified);
    });

    it("routes every view- or access-gated method through the gate", () => {
        for (const [file, methods] of Object.entries(CLASSIFIED)) {
            const rules = new Set(Object.values(methods));
            const source = readFileSync(join(API_ROOT, file), "utf8");
            if (rules.has("view")) {
                expect(source, file).toContain("requireRecordingView");
            }
            if (rules.has("access")) {
                expect(source, file).toContain("requireRecordingAccess");
            }
        }
    });
});
