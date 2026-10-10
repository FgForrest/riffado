import type { SettingsSection } from "@/types/settings";

/** A page of the user guide and, optionally, a heading on it. */
export interface HelpTarget {
    /** File name under `content/docs/user-guide`, without `.md`. */
    page: string;
    /** Heading id on that page, as the docs render it. */
    anchor?: string;
}

const SETTINGS_TOPICS: Record<SettingsSection, HelpTarget> = {
    providers: { page: "settings", anchor: "ai-providers" },
    transcription: { page: "settings", anchor: "transcription" },
    topics: { page: "settings", anchor: "topics" },
    learning: { page: "settings", anchor: "learning" },
    summary: { page: "settings", anchor: "summary" },
    display: { page: "settings", anchor: "display" },
    storage: {
        page: "exports-backups-retention",
        anchor: "deleting-old-data-automatically",
    },
    export: { page: "exports-backups-retention", anchor: "backups" },
    "google-account": {
        page: "exports-backups-retention",
        anchor: "to-google-drive",
    },
    mail: { page: "mail", anchor: "your-addresses" },
    billing: { page: "settings", anchor: "the-other-sections" },
    "plaud-account": { page: "settings", anchor: "the-other-sections" },
    sync: { page: "settings", anchor: "the-other-sections" },
    playback: { page: "settings", anchor: "the-other-sections" },
    notifications: { page: "settings", anchor: "the-other-sections" },
    "api-keys": { page: "settings", anchor: "the-other-sections" },
    webhooks: { page: "settings", anchor: "the-other-sections" },
    dev: { page: "settings", anchor: "the-other-sections" },
};

/** Every place in the app that links to the guide, by a stable name. */
export const HELP_TOPICS = {
    guide: { page: "index" },
    recordings: { page: "recordings" },
    "recordings.folders": { page: "recordings", anchor: "folders" },
    transcripts: { page: "transcripts", anchor: "reading-a-transcript" },
    summaries: { page: "summaries-and-tasks", anchor: "summaries" },
    "tasks.review": {
        page: "summaries-and-tasks",
        anchor: "tasks-from-a-summary",
    },
    "tasks.page": { page: "summaries-and-tasks", anchor: "the-tasks-page" },
    "almanac.people": { page: "almanac", anchor: "people" },
    "almanac.things": { page: "almanac", anchor: "things" },
    "almanac.vocabulary": { page: "almanac", anchor: "vocabulary" },
    "almanac.review": { page: "almanac", anchor: "review" },
    "learn.review": { page: "learn", anchor: "reviewing" },
    "exports.folder": {
        page: "exports-backups-retention",
        anchor: "folder-exports",
    },
    ...Object.fromEntries(
        Object.entries(SETTINGS_TOPICS).map(([section, target]) => [
            `settings.${section}`,
            target,
        ]),
    ),
} satisfies Record<string, HelpTarget>;

export type HelpTopic =
    | Exclude<keyof typeof HELP_TOPICS, `settings.${string}`>
    | `settings.${SettingsSection}`;

const TOPICS: Record<string, HelpTarget> = HELP_TOPICS;

/** Where a topic leads; the guide's first page for a topic it does not know. */
export function helpTarget(topic: HelpTopic): HelpTarget {
    return TOPICS[topic] ?? { page: "index" };
}

/** The URL of a topic, in the help drawer (`/help`) or the full docs (`/docs`). */
export function helpUrl(target: HelpTarget, base: "/help" | "/docs"): string {
    const path =
        target.page === "index"
            ? `${base}/user-guide`
            : `${base}/user-guide/${target.page}`;
    return target.anchor ? `${path}#${target.anchor}` : path;
}

/**
 * The topic for the screen at this location: the chapter about what the
 * page shows, at the section about its current state where there is one.
 */
export function topicForLocation(location: {
    pathname: string;
    search: string;
    hash: string;
}): HelpTopic {
    const { pathname } = location;
    const params = new URLSearchParams(location.search);
    if (pathname.startsWith("/settings")) {
        const section = location.hash.replace(/^#/, "");
        return section in SETTINGS_TOPICS
            ? `settings.${section as SettingsSection}`
            : "settings.providers";
    }
    if (pathname.startsWith("/dashboard")) {
        if (params.has("recording")) return "transcripts";
        if (params.has("folder")) return "recordings.folders";
        return "recordings";
    }
    if (pathname.startsWith("/recordings/")) return "transcripts";
    if (pathname.startsWith("/tasks")) return "tasks.page";
    if (pathname.startsWith("/almanac/things")) return "almanac.things";
    if (pathname.startsWith("/almanac/vocabulary")) return "almanac.vocabulary";
    if (pathname.startsWith("/almanac/review")) return "almanac.review";
    if (pathname.startsWith("/almanac")) return "almanac.people";
    return "guide";
}
