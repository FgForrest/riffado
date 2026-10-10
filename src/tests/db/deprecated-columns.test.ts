import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { DEPRECATED_COLUMNS } from "@/db/deprecated-columns";
import * as schema from "@/db/schema";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SCANNED_ROOTS = ["src", "scripts", "e2e", "mail-receiver"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const DEPRECATED_PROPERTY = /\bdeprecated[A-Z]\w*/g;

interface SchemaColumn {
    table: string;
    column: string;
    property: string;
}

function schemaColumns(): SchemaColumn[] {
    const columns: SchemaColumn[] = [];
    for (const value of Object.values(schema)) {
        if (!is(value, PgTable)) continue;
        const table = getTableConfig(value).name;
        for (const [property, column] of Object.entries(
            getTableColumns(value),
        )) {
            columns.push({ table, column: column.name, property });
        }
    }
    return columns;
}

function sourceFiles(dir: string): string[] {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
            files.push(...sourceFiles(full));
        } else if (SOURCE_EXTENSIONS.has(path.extname(entry))) {
            files.push(full);
        }
    }
    return files;
}

describe("deprecated columns", () => {
    const columns = schemaColumns();

    it("registers every deprecated schema property", () => {
        const unregistered = columns
            .filter((c) => c.property.startsWith("deprecated"))
            .filter(
                (c) =>
                    !DEPRECATED_COLUMNS.some(
                        (d) => d.table === c.table && d.column === c.column,
                    ),
            )
            .map((c) => `${c.table}.${c.column} (${c.property})`);
        expect(unregistered).toEqual([]);
    });

    it("names every registered column deprecated* in the schema", () => {
        const misnamed = DEPRECATED_COLUMNS.flatMap((d) => {
            const column = columns.find(
                (c) => c.table === d.table && c.column === d.column,
            );
            return column && !column.property.startsWith("deprecated")
                ? [`${d.table}.${d.column} (${column.property})`]
                : [];
        });
        expect(misnamed).toEqual([]);
    });

    it("drops every registered column by its dropAfter date", () => {
        const today = new Date().toISOString().slice(0, 10);
        const overdue = DEPRECATED_COLUMNS.filter(
            (d) =>
                d.dropAfter < today &&
                columns.some(
                    (c) => c.table === d.table && c.column === d.column,
                ),
        ).map(
            (d) =>
                `${d.table}.${d.column}: dropAfter ${d.dropAfter} passed; drop it (see src/db/deprecated-columns.ts)`,
        );
        expect(overdue).toEqual([]);
    });

    it("keeps dropAfter a valid date", () => {
        for (const d of DEPRECATED_COLUMNS) {
            expect(d.dropAfter).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(Number.isNaN(Date.parse(d.dropAfter))).toBe(false);
        }
    });

    it("uses no deprecated* property outside src/db/", () => {
        const dbDir = path.join(REPO_ROOT, "src", "db") + path.sep;
        const self = path.resolve(__filename);
        const uses: string[] = [];
        for (const root of SCANNED_ROOTS) {
            for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
                if (file.startsWith(dbDir) || file === self) continue;
                const text = readFileSync(file, "utf8");
                for (const match of text.matchAll(DEPRECATED_PROPERTY)) {
                    uses.push(`${path.relative(REPO_ROOT, file)}: ${match[0]}`);
                }
            }
        }
        expect(uses).toEqual([]);
    });
});
