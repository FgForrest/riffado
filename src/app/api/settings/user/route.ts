import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { userSettings, users } from "@/db/schema";
import {
    isValidSummaryPromptConfig,
    normalizeAiOutputLanguage,
} from "@/lib/ai/summary-presets";
import { requireApiSession } from "@/lib/auth-server";
import {
    decryptJsonField,
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { EXPORT_FORMATS } from "@/lib/export/formats";
import {
    clampRounds,
    MULTI_PASS_ROUNDS_DEFAULT,
} from "@/lib/summary/multi-pass";

// Enum allowlists. DB columns are `varchar`, not pg enums, so validation
// must happen here.
const ENUM_FIELDS = {
    playerScrubber: ["waveform", "slider"],
    listDensity: ["comfortable", "compact"],
    theme: ["light", "dark", "system"],
    dateTimeFormat: ["relative", "absolute", "iso"],
    recordingListSortOrder: ["newest", "oldest", "name"],
    transcriptionQuality: ["fast", "balanced", "accurate"],
    // Shared with the exporter and the settings picker -- see
    // `src/lib/export/formats.ts`. Hand-maintaining a second copy here is
    // what let this list accept `csv`/`zip` (which the exporter cannot
    // produce) while rejecting `txt`/`srt`/`vtt` (which it can).
    defaultExportFormat: EXPORT_FORMATS,
    transcriptMode: ["plaud_only", "keep_both"],
    preferredTranscriptSource: ["plaud", "riffado"],
} as const satisfies Record<string, readonly string[]>;

const ENUM_FIELD_SETS: Record<string, ReadonlySet<string>> = Object.fromEntries(
    Object.entries(ENUM_FIELDS).map(([k, v]) => [k, new Set(v)]),
);

const DEFAULT_SETTINGS = {
    autoTranscribe: false,
    autoSummarize: false,
    autoSummarizePreset: null,
    summaryMultiPass: false,
    summaryMultiPassRounds: MULTI_PASS_ROUNDS_DEFAULT,
    summaryMultiPassAuto: false,
    syncInterval: 300000,
    autoSyncEnabled: true,
    syncOnMount: true,
    syncOnVisibilityChange: true,
    syncNotifications: true,
    defaultPlaybackSpeed: 1.0,
    defaultVolume: 75,
    autoPlayNext: false,
    playerScrubber: "waveform" as const,
    defaultTranscriptionLanguage: null,
    transcriptionQuality: "balanced" as const,
    dateTimeFormat: "relative" as const,
    recordingListSortOrder: "newest" as const,
    itemsPerPage: 50,
    listDensity: "comfortable" as const,
    theme: "system" as const,
    autoDeleteRecordings: false,
    retentionDays: null,
    retentionDeleteAudio: false,
    retentionDeleteTranscript: false,
    retentionDeleteSummary: false,
    browserNotifications: true,
    emailNotifications: false,
    barkNotifications: false,
    notificationSound: true,
    notificationEmail: null,
    defaultExportFormat: "json" as const,
    autoExport: false,
    autoExportTranscript: false,
    autoExportSummary: false,
    backupFrequency: null,
    defaultProviders: null,
    onboardingCompleted: false,
    autoGenerateTitle: true,
    syncTitleToPlaud: false,
    aiOutputLanguage: null,
    importPlaudContent: false,
    transcriptMode: "plaud_only" as const,
    preferredTranscriptSource: "plaud" as const,
} as const;

const SETTINGS_FIELDS = [
    "autoTranscribe",
    "autoSummarize",
    "autoSummarizePreset",
    "summaryMultiPass",
    "summaryMultiPassRounds",
    "summaryMultiPassAuto",
    "syncInterval",
    "autoSyncEnabled",
    "syncOnMount",
    "syncOnVisibilityChange",
    "syncNotifications",
    "defaultPlaybackSpeed",
    "defaultVolume",
    "autoPlayNext",
    "playerScrubber",
    "defaultTranscriptionLanguage",
    "transcriptionQuality",
    "dateTimeFormat",
    "recordingListSortOrder",
    "itemsPerPage",
    "listDensity",
    "theme",
    "autoDeleteRecordings",
    "retentionDays",
    "retentionDeleteAudio",
    "retentionDeleteTranscript",
    "retentionDeleteSummary",
    "browserNotifications",
    "emailNotifications",
    "barkNotifications",
    "notificationSound",
    "notificationEmail",
    "defaultExportFormat",
    "autoExport",
    "autoExportTranscript",
    "autoExportSummary",
    "backupFrequency",
    "defaultProviders",
    "onboardingCompleted",
    "autoGenerateTitle",
    "syncTitleToPlaud",
    "aiOutputLanguage",
    "importPlaudContent",
    "transcriptMode",
    "preferredTranscriptSource",
] as const;

function extractSettings(settings: typeof userSettings.$inferSelect) {
    const result: Record<string, unknown> = {};
    for (const field of SETTINGS_FIELDS) {
        result[field] = settings[field];
    }
    result.barkPushUrl = settings.barkPushUrl || null;
    result.barkPushUrlSet = !!settings.barkPushUrl;
    return result;
}

export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const [settings] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, session.user.id))
        .limit(1);

    const userEmail = session.user.email || "";

    const [userRow] = await db
        .select({
            marketingEmailConsent: users.marketingEmailConsent,
        })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1);
    const marketingEmailConsent = userRow?.marketingEmailConsent ?? false;

    if (!settings) {
        return NextResponse.json({
            ...DEFAULT_SETTINGS,
            titleGenerationPrompt: null,
            barkPushUrl: null,
            barkPushUrlSet: false,
            userEmail,
            marketingEmailConsent,
        });
    }

    const settingsData = extractSettings(settings);
    if (settings.titleGenerationPrompt) {
        settingsData.titleGenerationPrompt = decryptJsonField(
            settings.titleGenerationPrompt,
        );
    }
    if (settings.summaryPrompt) {
        settingsData.summaryPrompt = decryptJsonField(settings.summaryPrompt);
    }
    settingsData.summaryMergePrompt = settings.summaryMergePrompt
        ? decryptText(settings.summaryMergePrompt)
        : null;
    return NextResponse.json({
        ...settingsData,
        userEmail,
        marketingEmailConsent,
    });
});

export const PUT = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const body = await request.json();

    const [existing] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, session.user.id))
        .limit(1);

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    const insertData: Record<string, unknown> = {
        userId: session.user.id,
    };

    for (const field of SETTINGS_FIELDS) {
        let value = body[field];
        if (
            field in ENUM_FIELDS &&
            value !== undefined &&
            value !== null &&
            !ENUM_FIELD_SETS[field].has(value as string)
        ) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                `Invalid ${field} value`,
                400,
                { field },
            );
        }
        if (
            field === "aiOutputLanguage" &&
            value !== undefined &&
            value !== null
        ) {
            const normalized = normalizeAiOutputLanguage(value);
            if (normalized === null) {
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Invalid aiOutputLanguage value",
                    400,
                    { field: "aiOutputLanguage" },
                );
            }
            value = normalized;
        }
        // Clamped here rather than trusted from the body: this is the only
        // write path, so a value out of range can never reach the column --
        // whatever the client sends, and whatever a future client forgets.
        if (field === "summaryMultiPassRounds" && value !== undefined) {
            value = clampRounds(value);
        }
        if (value !== undefined) {
            updateData[field] = value;
            insertData[field] = value;
        } else if (!existing) {
            insertData[field] = DEFAULT_SETTINGS[field];
        }
    }

    if (body.titleGenerationPrompt !== undefined) {
        const encrypted =
            body.titleGenerationPrompt === null
                ? null
                : encryptJsonField(body.titleGenerationPrompt);
        updateData.titleGenerationPrompt = encrypted;
        insertData.titleGenerationPrompt = encrypted;
    } else if (!existing) {
        insertData.titleGenerationPrompt = null;
    }

    if (body.summaryPrompt !== undefined) {
        if (
            body.summaryPrompt !== null &&
            !isValidSummaryPromptConfig(body.summaryPrompt)
        ) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "Invalid summaryPrompt value",
                400,
                { field: "summaryPrompt" },
            );
        }
        const encrypted =
            body.summaryPrompt === null
                ? null
                : encryptJsonField(body.summaryPrompt);
        updateData.summaryPrompt = encrypted;
        insertData.summaryPrompt = encrypted;
    } else if (!existing) {
        insertData.summaryPrompt = null;
    }

    // User-authored prose that can name people, clients and projects, so it
    // is encrypted at rest like the summary prompts. Blank means "use the
    // built-in merge prompt" and is stored as NULL rather than an empty
    // string, so there is one representation of "not set".
    if (body.summaryMergePrompt !== undefined) {
        const trimmed =
            typeof body.summaryMergePrompt === "string"
                ? body.summaryMergePrompt.trim()
                : null;
        const stored = trimmed ? encryptText(trimmed) : null;
        updateData.summaryMergePrompt = stored;
        insertData.summaryMergePrompt = stored;
    } else if (!existing) {
        insertData.summaryMergePrompt = null;
    }

    if (body.barkPushUrl !== undefined) {
        if (body.barkPushUrl === null || body.barkPushUrl === "") {
            updateData.barkPushUrl = null;
            insertData.barkPushUrl = null;
        } else {
            updateData.barkPushUrl = body.barkPushUrl;
            insertData.barkPushUrl = body.barkPushUrl;
        }
    } else if (!existing) {
        insertData.barkPushUrl = null;
    }

    if (existing) {
        await db
            .update(userSettings)
            .set(updateData)
            .where(eq(userSettings.userId, session.user.id));
    } else {
        await db
            .insert(userSettings)
            .values(insertData as typeof userSettings.$inferInsert);
    }

    if (typeof body.marketingEmailConsent === "boolean") {
        await db
            .update(users)
            .set({
                marketingEmailConsent: body.marketingEmailConsent,
                updatedAt: new Date(),
            })
            .where(eq(users.id, session.user.id));
    }

    return NextResponse.json({ success: true });
});
