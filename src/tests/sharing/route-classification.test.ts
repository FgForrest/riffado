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
 *   - `tasks`: authorized per task by the rules in `src/lib/tasks/access.ts`
 *     (see, close, edit), read under the recording lock for a change.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

type Rule =
    | "owner"
    | "access"
    | "view"
    | "folders"
    | "job"
    | "people"
    | "tasks";

const CLASSIFIED: Record<string, Record<string, Rule>> = {
    "recordings/[id]/route.ts": {
        GET: "owner",
        // The title: the owner on the private view, the organization
        // account on the Organization view while shared.
        PATCH: "view",
        DELETE: "owner",
    },
    "recordings/[id]/audio/route.ts": { GET: "access" },
    "recordings/[id]/ai-cost/route.ts": { GET: "view" },
    "recordings/[id]/peaks/route.ts": { POST: "access", PUT: "access" },
    "recordings/[id]/erase/route.ts": { POST: "owner" },
    "recordings/[id]/folders/route.ts": {
        POST: "folders",
        PATCH: "folders",
        DELETE: "folders",
    },
    // What automatic Learn held back: the hold and its jobs are the
    // owner's, on the private view.
    "recordings/[id]/follow-ups/route.ts": { GET: "owner" },
    // Learn: whoever may change the recording in the view (the owner on
    // the private view, the organization account on the Organization's).
    "recordings/[id]/learn/route.ts": { GET: "view", POST: "view" },
    "recordings/[id]/review/route.ts": { GET: "view" },
    "recordings/[id]/review/items/[itemId]/route.ts": { PATCH: "view" },
    "recordings/[id]/review/finish/route.ts": { POST: "view" },
    "recordings/[id]/review/dismissals/route.ts": { DELETE: "view" },
    // Corrections: read in either view; undone by whoever may change it.
    "recordings/[id]/corrections/route.ts": { GET: "view" },
    "recordings/[id]/corrections/[correctionId]/route.ts": { DELETE: "view" },
    "recordings/[id]/markdown/[kind]/route.ts": { GET: "view" },
    "recordings/[id]/speakers/route.ts": { GET: "view", PUT: "view" },
    "recordings/[id]/summary/route.ts": {
        GET: "view",
        POST: "view",
        DELETE: "view",
    },
    // Topics are written onto the owner's transcript row: by the owner on
    // the private view, by the organization account on the Organization
    // view while shared.
    // Tasks: seen by whoever sees the recording, reviewed and changed by
    // whoever may change it, closed also by the owner and the assignee.
    "recordings/[id]/tasks/route.ts": { GET: "tasks", POST: "tasks" },
    "recordings/[id]/tasks/accept/route.ts": { POST: "tasks" },
    "recordings/[id]/tasks/merge/route.ts": { POST: "tasks" },
    "recordings/[id]/tasks/updates/[updateId]/route.ts": { PATCH: "tasks" },
    "recordings/[id]/topics/route.ts": { GET: "view", POST: "view" },
    "recordings/[id]/transcribe/route.ts": { GET: "view", POST: "view" },
    "recordings/[id]/transcription/from-browser/route.ts": { POST: "owner" },
    // The private view, which is the owner's alone.
    "recordings/[id]/withdraw-preview/route.ts": { GET: "view" },
    "jobs/[id]/route.ts": { GET: "job" },
    "folders/route.ts": { GET: "folders", POST: "folders" },
    "folders/[id]/route.ts": { PATCH: "folders", DELETE: "folders" },
    "folders/[id]/exports/route.ts": { GET: "owner", POST: "owner" },
    "folders/[id]/exports/[exportId]/route.ts": {
        PATCH: "owner",
        DELETE: "owner",
    },
    "folders/[id]/synchronize/route.ts": { POST: "owner" },
    // A folder's mail addresses: seen by whoever reaches the folder, changed
    // by whoever may rename it.
    "folders/[id]/mail-addresses/route.ts": { GET: "folders", PUT: "folders" },
    "folders/[id]/mail-addresses/[addressId]/route.ts": { DELETE: "folders" },
    // Mail is its owner's alone: a shared mail is read through its folder.
    "mail/[id]/route.ts": { GET: "owner", DELETE: "owner" },
    "mail/[id]/html/route.ts": { GET: "owner" },
    "mail/[id]/raw/route.ts": { GET: "owner" },
    "mail/[id]/attachments/[index]/route.ts": { GET: "owner" },
    "mail/[id]/share/route.ts": { POST: "owner" },
    "mail/addresses/route.ts": { GET: "owner", POST: "owner" },
    "mail/addresses/[id]/route.ts": { PATCH: "owner", DELETE: "owner" },
    "mail/addresses/[id]/rotate/route.ts": { POST: "owner" },
    "mail/delivery-log/route.ts": { GET: "owner" },
    "people/route.ts": { GET: "people", POST: "people" },
    "people/[id]/route.ts": {
        GET: "people",
        PATCH: "people",
        POST: "people",
        DELETE: "people",
    },
};

const API_ROOT = join(__dirname, "../../app/api");
const GUARDED_DIRECTORIES = [
    "recordings/[id]",
    "jobs",
    "folders",
    "people",
    "mail",
];
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
            if (rules.has("tasks")) {
                expect(source, file).toContain("requireTaskViewer");
            }
        }
    });
});
