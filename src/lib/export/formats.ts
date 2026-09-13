/**
 * The export formats `GET /api/export` actually implements.
 *
 * Single source of truth for three places that each used to keep their own
 * copy, and had drifted: the enum allowlist in `PUT /api/settings/user`,
 * the picker in the Export & Backup settings section, and the exporter's
 * own `switch`. The allowlist accepted `csv` and `zip` -- which the
 * exporter has no branch for -- while rejecting `txt`, `srt` and `vtt`,
 * which it does implement. The visible symptom was that picking anything
 * but JSON as the default export format failed to save with "Failed to
 * save settings", because the PUT 400'd on its own allowlist.
 *
 * Adding a format means adding it here, giving it a `case` in the export
 * route, and giving it a label in the settings picker -- the last one is
 * enforced by the compiler via `Record<ExportFormat, ...>`.
 */
export const EXPORT_FORMATS = ["json", "txt", "srt", "vtt"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: unknown): value is ExportFormat {
    return (
        typeof value === "string" &&
        (EXPORT_FORMATS as readonly string[]).includes(value)
    );
}
