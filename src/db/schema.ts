import { sql } from "drizzle-orm";
import {
    type AnyPgColumn,
    bigint,
    boolean,
    date,
    index,
    integer,
    jsonb,
    pgEnum,
    pgTable,
    primaryKey,
    real,
    text,
    timestamp,
    unique,
    uniqueIndex,
    varchar,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";

export const userPlanEnum = pgEnum("user_plan", [
    "self_host",
    "hosted_free",
    "hosted_pro",
]);

export const foundingMemberReservationStatusEnum = pgEnum(
    "founding_member_reservation_status",
    ["reserved", "consumed", "released", "expired"],
);

export const stripeWebhookEventStatusEnum = pgEnum(
    "stripe_webhook_event_status",
    ["pending", "processing", "completed", "failed"],
);

// Better Auth tables (handled by Better Auth)
export const users = pgTable("users", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => nanoid()),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    name: text("name"),
    // Hosted-mode operator action: when set, the user is suspended.
    // - `/api/v1/*` and the web app return a suspension state on next request
    //   (cooperative; existing in-flight requests are not interrupted).
    // - The sync worker skips suspended users on its next claim.
    // Set/cleared exclusively via the admin dashboard suspend action; the
    // self-host code path never writes this column because the admin gate
    // is locked behind IS_HOSTED.
    suspendedAt: timestamp("suspended_at"),
    suspendedReason: text("suspended_reason"),
    marketingEmailConsent: boolean("marketing_email_consent")
        .notNull()
        .default(false),
    // Hosted billing plan. NULL on self-host and for hosted users created
    // before the billing rollout (backfilled by scripts/billing-backfill.ts).
    plan: userPlanEnum("plan"),
    // Set by the billing rollout backfill to (launch_date + 30 days) for
    // every pre-launch hosted user. While > now(), enforcement skips caps.
    planTransitionUntil: timestamp("plan_transition_until"),
    // Per-cycle Mynah transcription budget in seconds. Reset by cycle-close.
    monthlyMynahSecondsRemaining: integer("monthly_mynah_seconds_remaining")
        .notNull()
        .default(0),
    // Next time cycle-close should refresh the Mynah counter. NULL = never.
    monthlyMynahGrantResetAt: timestamp("monthly_mynah_grant_reset_at"),
    // True while the user currently retains founding monthly pricing. Cleared
    // when they cancel/lapse; the separate claimed timestamp is never cleared
    // so the first-100 capacity does not reopen.
    foundingMember: boolean("founding_member").notNull().default(false),
    foundingMemberClaimedAt: timestamp("founding_member_claimed_at"),
    // First time the user was successfully charged. NULL = never paid.
    // Used to branch the grace-period policy on lapse:
    //  - NULL (trial non-convert) -> BILLING_TRIAL_GRACE_DAYS (7)
    //  - set (former paying user)  -> BILLING_PAID_GRACE_DAYS (30)
    // Grandfather: pre-launch users are treated as Path B (paid) by checking
    // `createdAt < BILLING_LAUNCH_DATE` at deletion-scheduling time, so this
    // column staying NULL for grandfathered users is intentional.
    everPaidAt: timestamp("ever_paid_at"),
    // When the user enters a lapsed state (trial ended w/o payment, sub
    // canceled/failed-out, etc.) this is set to now() + grace_days. The
    // billing worker deletes the account at that time. Cleared on reactivate.
    accountDeletionScheduledAt: timestamp("account_deletion_scheduled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Admin read-access audit log (hosted-only).
// Append-only. One row per admin page view or admin API hit. Self-host never
// writes here because the admin gate trips at IS_HOSTED.
export const adminAuditLog = pgTable(
    "admin_audit_log",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        // Audit retention: keep the row even if the admin's user record is
        // later deleted. `adminUserEmail` snapshots the email at log time so
        // the trail remains attributable post-deletion. `adminUserId` becomes
        // null on user delete (set null), so the FK relationship survives a
        // user purge without erasing history.
        adminUserId: text("admin_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        adminUserEmail: text("admin_user_email").notNull(),
        route: text("route").notNull(),
        method: varchar("method", { length: 10 }).notNull(),
        ip: text("ip"),
        userAgent: text("user_agent"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        adminCreatedIdx: index("admin_audit_log_admin_created_idx").on(
            table.adminUserId,
            table.createdAt,
        ),
        createdIdx: index("admin_audit_log_created_idx").on(table.createdAt),
    }),
);

// Admin mutation log (hosted-only). Separate from read audit so mutations
// are easy to query/review in isolation. before/after JSON captures the
// minimum diff needed to understand the change without storing PII
// content (e.g., for softDeleteRecording we store filename hashes/sizes,
// not transcripts).
export const adminActionLog = pgTable(
    "admin_action_log",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        // Same retention model as admin_audit_log: actor user-id becomes
        // null on delete; email snapshot keeps the row attributable.
        // targetUserId already has no FK to allow logging actions on
        // already-deleted target users.
        adminUserId: text("admin_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        adminUserEmail: text("admin_user_email").notNull(),
        action: varchar("action", { length: 64 }).notNull(),
        targetUserId: text("target_user_id"),
        targetResourceId: text("target_resource_id"),
        reason: text("reason").notNull(),
        before: jsonb("before"),
        after: jsonb("after"),
        ip: text("ip"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        createdIdx: index("admin_action_log_created_idx").on(table.createdAt),
        targetUserIdx: index("admin_action_log_target_user_idx").on(
            table.targetUserId,
            table.createdAt,
        ),
    }),
);

export const sessions = pgTable("sessions", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => nanoid()),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => nanoid()),
    userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => nanoid()),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Plaud connection
export const plaudConnections = pgTable("plaud_connections", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => nanoid()),
    userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    // Encrypted bearer token (long-lived ≈300 days per Plaud's JWT claims)
    bearerToken: text("bearer_token").notNull(),
    // Regional API server base URL (e.g. https://api-euc1.plaud.ai for EU users)
    apiBase: text("api_base").notNull().default("https://api.plaud.ai"),
    // Email of the linked Plaud account (captured during OTP flow). Null for
    // legacy connections created via the bearer-token paste flow.
    plaudEmail: text("plaud_email"),
    // Plaud workspace ID (e.g. ws_xxxxxxxxxxxx) used to mint short-lived
    // workspace tokens (WT) from the long-lived user token (UT). The WT is
    // required by recording endpoints (/file/simple/web, /device/list, ...)
    // on regional servers; without it those endpoints return empty lists.
    // Null for connections created before this column existed; resolved and
    // persisted lazily on next sync.
    workspaceId: text("workspace_id"),
    // Set when Plaud rejects the stored token during sync (HTTP 401 ->
    // PLAUD_INVALID_TOKEN), meaning the user must reconnect. Cleared on the
    // next successful sync (self-healing on transient 401s) and on reconnect.
    // Distinct from deleting the row: the connection and synced recordings
    // stay put so reconnect is a modal, not re-onboarding.
    invalidatedAt: timestamp("invalidated_at"),
    lastSync: timestamp("last_sync"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Plaud devices
export const plaudDevices = pgTable(
    "plaud_devices",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        serialNumber: varchar("serial_number", { length: 255 }).notNull(),
        name: text("name").notNull(),
        model: varchar("model", { length: 50 }).notNull(),
        versionNumber: integer("version_number"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        // Ensure each user can only have one entry per device serial number
        userDeviceUnique: unique().on(table.userId, table.serialNumber),
        // Index for querying devices by user
        userIdIdx: index("plaud_devices_user_id_idx").on(table.userId),
    }),
);

// Recordings
export const recordings = pgTable(
    "recordings",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        deviceSn: varchar("device_sn", { length: 255 }).notNull(),
        // Unique ID from Plaud API, scoped per Riffado user.
        plaudFileId: varchar("plaud_file_id", { length: 255 }).notNull(),
        filename: text("filename").notNull(),
        duration: integer("duration").notNull(), // milliseconds
        startTime: timestamp("start_time").notNull(),
        endTime: timestamp("end_time").notNull(),
        filesize: integer("filesize").notNull(), // bytes
        fileMd5: varchar("file_md5", { length: 32 }).notNull(),
        // Storage info
        storageType: varchar("storage_type", { length: 10 }).notNull(), // 'local' or 's3'
        storagePath: text("storage_path").notNull(), // Local path or S3 key
        // Reserved readable basename for the audio and its sidecars. Null on
        // legacy rows until the startup reconciliation worker allocates one.
        storageFilename: text("storage_filename"),
        downloadedAt: timestamp("downloaded_at"),
        // Version from Plaud API (for detecting updates)
        plaudVersion: varchar("plaud_version", { length: 50 }).notNull(),
        // Metadata
        timezone: integer("timezone"),
        zonemins: integer("zonemins"),
        scene: integer("scene"),
        isTrash: boolean("is_trash").notNull().default(false),
        // Coarse amplitude peaks for the audio waveform, generated
        // client-side on first listen and POSTed back via
        // /api/recordings/[id]/peaks. Null until the first successful
        // decode; idempotent thereafter (write-once). Stored as a JSON
        // array of N normalized floats in [0, 1] (typically N=500),
        // so payload is ~3–6 KB. Used purely for visualization — no
        // audio reconstruction is possible from these values.
        waveformPeaks: jsonb("waveform_peaks"),
        // Soft-delete tombstone. Set when the user deletes a recording from
        // Riffado's UI. Sync skips tombstoned rows so re-syncing from Plaud
        // does not resurrect deleted recordings. The audio file is hard-deleted
        // from storage at delete time; this row is retained only as a marker
        // keyed by plaudFileId. See issue #56.
        deletedAt: timestamp("deleted_at"),
        // Retention markers. Set by the retention sweep
        // (src/lib/retention/worker.ts) when it removes one kind of data
        // from a recording that has aged past the user's retention period.
        // The recording row itself always survives -- only the payload of
        // the selected kinds goes -- so the library keeps its metadata and
        // the UI can say *why* something is missing instead of erroring.
        //
        // These are load-bearing, not cosmetic: without them a reaped
        // transcript looks identical to one that was never made, and the
        // next sync would auto-transcribe it straight back (see
        // `listUntranscribedRecordingIds`). Cleared whenever the data
        // legitimately comes back -- a Plaud version bump re-downloads the
        // audio, a manual re-run rewrites the transcript or summary.
        audioReapedAt: timestamp("audio_reaped_at"),
        transcriptReapedAt: timestamp("transcript_reaped_at"),
        summaryReapedAt: timestamp("summary_reaped_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        // Index for querying recordings by user (most common query)
        userIdIdx: index("recordings_user_id_idx").on(table.userId),
        // Index for sync operations - looking up by plaudFileId
        plaudFileIdIdx: index("recordings_plaud_file_id_idx").on(
            table.plaudFileId,
        ),
        // Composite index for user recordings sorted by start time (dashboard query)
        userStartTimeIdx: index("recordings_user_id_start_time_idx").on(
            table.userId,
            table.startTime,
        ),
        userPlaudFileUnique: unique(
            "recordings_user_id_plaud_file_id_unique",
        ).on(table.userId, table.plaudFileId),
        userStorageFilenameStemUnique: uniqueIndex(
            "recordings_user_id_storage_filename_stem_unique",
        )
            .on(
                table.userId,
                sql`regexp_replace(${table.storageFilename}, '\\.[^.]+$', '')`,
            )
            .where(
                sql`${table.storageFilename} is not null and ${table.deletedAt} is null`,
            ),
    }),
);

export const recordingFolders = pgTable(
    "recording_folders",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        parentId: text("parent_id").references(
            (): AnyPgColumn => recordingFolders.id,
            { onDelete: "cascade" },
        ),
        name: text("name").notNull(),
        nameHash: varchar("name_hash", { length: 64 }).notNull(),
        kind: varchar("kind", { length: 16 })
            .$type<"private" | "public" | "custom">()
            .notNull()
            .default("custom"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        userIdIdx: index("recording_folders_user_id_idx").on(table.userId),
        parentIdIdx: index("recording_folders_parent_id_idx").on(
            table.parentId,
        ),
        siblingNameUnique: uniqueIndex(
            "recording_folders_user_parent_name_unique",
        ).on(table.userId, table.parentId, table.nameHash),
        rootKindUnique: uniqueIndex("recording_folders_user_root_kind_unique")
            .on(table.userId, table.kind)
            .where(sql`${table.kind} in ('private', 'public')`),
    }),
);

export const recordingFolderAssignments = pgTable(
    "recording_folder_assignments",
    {
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        recordingId: text("recording_id")
            .notNull()
            .references(() => recordings.id, { onDelete: "cascade" }),
        folderId: text("folder_id")
            .notNull()
            .references(() => recordingFolders.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.recordingId, table.folderId] }),
        userIdIdx: index("recording_folder_assignments_user_id_idx").on(
            table.userId,
        ),
        folderIdIdx: index("recording_folder_assignments_folder_id_idx").on(
            table.folderId,
        ),
    }),
);

// Transcriptions
export const transcriptions = pgTable(
    "transcriptions",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        recordingId: text("recording_id")
            .notNull()
            .references(() => recordings.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        text: text("text").notNull(),
        detectedLanguage: varchar("detected_language", { length: 10 }), // ISO 639-1 language code detected by Whisper
        transcriptionType: varchar("transcription_type", { length: 10 })
            .notNull()
            .default("server"), // 'server' or 'browser'
        provider: varchar("provider", { length: 100 }).notNull(), // e.g., 'openai', 'groq', 'browser'
        model: varchar("model", { length: 100 }).notNull(), // e.g., 'whisper-1', 'whisper-large-v3-turbo', 'whisper-base'
        // Provenance of this transcript, orthogonal to transcriptionType:
        //   'riffado' = produced by the user's own provider (server/browser)
        //   'plaud'   = imported from Plaud's native transcription
        //   'mixed'   = user-edited combination of the above (see #204)
        source: varchar("source", { length: 20 }).notNull().default("riffado"),
        // Diarized turns with per-turn timings, encrypted like the text they
        // were rendered from. Null for undiarized providers and for every
        // transcript produced before this shipped; `parseSpeakerTurns` over
        // the flat text stays the fallback for those.
        //
        // Written on every upsert, including as NULL -- re-transcribing a
        // diarized recording with an undiarized model has to clear the old
        // turns, or the row keeps a dialog structure its text no longer has.
        // Same reasoning as `ai_enhancements.multi_pass_rounds`.
        turns: jsonb("turns"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        // Index for looking up transcription by recording (most common query)
        recordingIdIdx: index("transcriptions_recording_id_idx").on(
            table.recordingId,
        ),
        // Index for querying user's transcriptions
        userIdIdx: index("transcriptions_user_id_idx").on(table.userId),
        // At most one transcript per (recording, user, source) so a
        // Plaud-imported transcript and the user's own provider can coexist
        // while each source still upserts cleanly.
        recordingUserSourceUnique: unique(
            "transcriptions_recording_user_source_unique",
        ).on(table.recordingId, table.userId, table.source),
    }),
);

// Knowledge base: the people a user's recordings are about.
//
// Provenance is uniform across every row this feature writes. `source` says
// how we came to believe something and `status` says whether a human has
// confirmed it; together they replace a graded trust ladder, because the only
// distinction that changes behaviour is confirmed-by-a-person versus
// proposed-by-a-machine. Nothing proposed ever reaches a summary, an export
// or the API.
export const factSourceEnum = pgEnum("fact_source", [
    "user",
    "calendar",
    "meet",
    "llm",
    "heuristic",
]);

export const factStatusEnum = pgEnum("fact_status", [
    "confirmed",
    "suggested",
    "rejected",
]);

export const people = pgTable(
    "people",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        // Encrypted: these are personal data about third parties who never
        // had an account here, held in a database that is multi-tenant when
        // hosted. See `src/lib/knowledge/lookup-hash.ts` for why the email
        // is additionally hashed instead of simply left in the clear.
        displayName: text("display_name").notNull(),
        primaryEmail: text("primary_email"),
        notes: text("notes"),
        // HMAC of the normalized primary email. Encryption is not
        // deterministic, so this is what a lookup and the uniqueness
        // constraint below actually run against.
        primaryEmailHash: varchar("primary_email_hash", { length: 64 }),
        // Set when this row lost a merge. The row survives as a tombstone so
        // that anything still pointing at the old id resolves to the winner
        // instead of dangling.
        mergedIntoId: text("merged_into_id"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        userIdIdx: index("people_user_id_idx").on(table.userId),
        // Postgres treats NULLs as distinct, so any number of people per user
        // may have no email at all -- which is the common case for someone
        // named from a transcript rather than a calendar invite.
        userEmailHashUnique: unique("people_user_id_email_hash_unique").on(
            table.userId,
            table.primaryEmailHash,
        ),
    }),
);

// Which person each anonymous speaker label in a transcript refers to.
//
// Keyed on the transcript, not the recording. `transcriptions` deliberately
// allows a Plaud-imported transcript and the user's own provider's output to
// coexist for one recording, and their `speaker_0`s are different people
// produced by different diarizers -- so a recording-keyed overlay would apply
// a name to whichever transcript happened to be read.
export const transcriptSpeakers = pgTable(
    "transcript_speakers",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        transcriptionId: text("transcription_id")
            .notNull()
            .references(() => transcriptions.id, { onDelete: "cascade" }),
        // The raw provider label as stored in `transcriptions.turns`, e.g.
        // `speaker_0`. Never rewritten; the name is projected over it.
        label: varchar("label", { length: 64 }).notNull(),
        // Null means the label is unresolved, which is a perfectly good
        // outcome: leaving a speaker unknown is always preferable to naming
        // the wrong person, because these names drive meeting minutes.
        personId: text("person_id").references(() => people.id, {
            onDelete: "cascade",
        }),
        source: factSourceEnum("source").notNull(),
        status: factStatusEnum("status").notNull().default("suggested"),
        confidence: real("confidence"),
        // Offset into the recording of the moment that justified the guess,
        // so the confirm UI can seek the player to the proof. The quote
        // itself is re-derived from `transcriptions.turns` at render time
        // rather than stored: copying transcript content into a second column
        // would put it outside the encrypted text and outlive the retention
        // sweep that deletes the transcript.
        evidenceStartMs: integer("evidence_start_ms"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        transcriptLabelUnique: unique(
            "transcript_speakers_transcription_id_label_unique",
        ).on(table.transcriptionId, table.label),
        personIdx: index("transcript_speakers_person_id_idx").on(
            table.personId,
        ),
        userIdIdx: index("transcript_speakers_user_id_idx").on(table.userId),
    }),
);

// AI Enhancements
export const aiEnhancements = pgTable(
    "ai_enhancements",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        recordingId: text("recording_id")
            .notNull()
            .references(() => recordings.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        transcriptionId: text("transcription_id").references(
            () => transcriptions.id,
            { onDelete: "set null" },
        ),
        summary: text("summary"),
        actionItems: jsonb("action_items"), // Array of action items
        keyPoints: jsonb("key_points"), // Array of key points
        provider: varchar("provider", { length: 100 }).notNull(), // e.g., 'openai', 'anthropic-via-openrouter'
        model: varchar("model", { length: 100 }).notNull(), // e.g., 'gpt-4o', 'claude-3.5-sonnet'
        // Provenance: 'riffado' = generated by the user's provider,
        // 'plaud' = imported from Plaud's native summary.
        source: varchar("source", { length: 20 }).notNull().default("riffado"),
        // Multi-pass provenance. NULL means this summary was a single pass
        // (or predates the feature) -- the UI shows no badge at all then.
        //
        // Stored rather than derived because the run is the only place this
        // is known: a degraded run (fewer passes usable than requested, or a
        // merge that failed) produces a summary indistinguishable from a
        // clean one, so without persisting it the user cannot tell that the
        // summary in front of them was built from two passes instead of
        // three. That distinction only matters after the fact.
        multiPassRounds: integer("multi_pass_rounds"),
        multiPassUsed: integer("multi_pass_passes_used"),
        multiPassMerged: boolean("multi_pass_merged"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        userRecordingSourceUnique: unique(
            "ai_enhancements_recording_user_source_unique",
        ).on(table.recordingId, table.userId, table.source),
        transcriptionIdIdx: index("ai_enhancements_transcription_id_idx").on(
            table.transcriptionId,
        ),
    }),
);

// API Credentials (encrypted)
export const apiCredentials = pgTable("api_credentials", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => nanoid()),
    userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 100 }).notNull(), // e.g., 'openai', 'groq', 'together-ai'
    // Encrypted API key
    apiKey: text("api_key").notNull(),
    // Optional custom base URL (for OpenAI-compatible APIs)
    baseUrl: text("base_url"), // e.g., 'https://api.groq.com/openai/v1'
    // Default model for this provider
    defaultModel: varchar("default_model", { length: 100 }),
    // Whether this is the default provider for transcription/enhancement
    isDefaultTranscription: boolean("is_default_transcription")
        .notNull()
        .default(false),
    isDefaultEnhancement: boolean("is_default_enhancement")
        .notNull()
        .default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// User Settings
export const userSettings = pgTable("user_settings", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => nanoid()),
    userId: text("user_id")
        .notNull()
        .unique()
        .references(() => users.id, { onDelete: "cascade" }),
    // Sync interval in milliseconds (default: 300000 = 5 minutes)
    syncInterval: integer("sync_interval").notNull().default(300000),
    // Auto-transcribe new recordings
    autoTranscribe: boolean("auto_transcribe").notNull().default(false),
    // Auto-summarize after a successful transcription (manual, post-sync
    // auto, or re-transcribe). Runs the same summary pipeline as the
    // manual button. Orthogonal to autoTranscribe -- fires on any
    // successful transcription, not just auto-transcribed ones.
    autoSummarize: boolean("auto_summarize").notNull().default(false),
    // Preset id override for the auto-summary path. Null inherits
    // summaryPrompt.selectedPrompt (the manual default).
    autoSummarizePreset: text("auto_summarize_preset"),
    // Multi-pass summarization: run the summary prompt several times in
    // parallel and merge the results. This raises key-point RECALL --
    // independent passes omit different things, so their union omits
    // less. It does not make any individual claim more accurate, and the
    // merge step can introduce drift of its own, which is why the setting
    // is called "multi-pass" rather than "more accurate".
    summaryMultiPass: boolean("summary_multi_pass").notNull().default(false),
    // Parallel passes per summary. Every pass re-sends the FULL
    // transcript, so N rounds costs roughly N times a single summary; the
    // merge adds only a few percent on top, because its input is the N
    // summaries rather than the transcript. Clamped on write (see
    // MULTI_PASS_ROUNDS_MIN/MAX) -- an unbounded N on a long transcript is
    // both a bill and a self-inflicted rate limit.
    summaryMultiPassRounds: integer("summary_multi_pass_rounds")
        .notNull()
        .default(3),
    // Whether the auto-summarize path gets multi-pass too. Off by default
    // even when the feature is on: a manual summary is one recording the
    // user chose and is waiting on, while auto can be a dozen from a
    // single sync -- and against a subscription-backed provider the cost
    // is not money but the rolling quota shared with the user's own
    // sessions.
    summaryMultiPassAuto: boolean("summary_multi_pass_auto")
        .notNull()
        .default(false),
    // Overrides the built-in merge prompt; null uses DEFAULT_MERGE_PROMPT.
    // Encrypted at rest like `summaryPrompt`, because it is user-authored
    // text that can name people, clients and projects.
    summaryMergePrompt: text("summary_merge_prompt"),
    // Sync settings
    autoSyncEnabled: boolean("auto_sync_enabled").notNull().default(true),
    syncOnMount: boolean("sync_on_mount").notNull().default(true),
    syncOnVisibilityChange: boolean("sync_on_visibility_change")
        .notNull()
        .default(true),
    syncNotifications: boolean("sync_notifications").notNull().default(true),
    // Playback settings
    defaultPlaybackSpeed: real("default_playback_speed").notNull().default(1.0),
    defaultVolume: integer("default_volume").notNull().default(75),
    autoPlayNext: boolean("auto_play_next").notNull().default(false),
    // Player scrubber style: 'waveform' (default) shows the canvas
    // amplitude waveform when peaks are available; 'slider' forces the
    // plain progress bar regardless. Users who prefer the minimal look
    // (or whose machines struggle with the canvas) opt out here.
    playerScrubber: varchar("player_scrubber", { length: 20 })
        .notNull()
        .default("waveform"),
    // Transcription settings
    defaultTranscriptionLanguage: varchar("default_transcription_language", {
        length: 10,
    }), // ISO 639-1 code, nullable for auto-detect
    transcriptionQuality: varchar("transcription_quality", { length: 20 })
        .notNull()
        .default("balanced"), // 'fast', 'balanced', 'accurate'
    // Plaud-native content import (feature #204). When enabled, sync imports
    // Plaud's own transcript/summary (source='plaud') for recordings Plaud
    // has already processed, instead of only the audio.
    importPlaudContent: boolean("import_plaud_content")
        .notNull()
        .default(false),
    // When a Plaud transcript is imported, whether the user's own provider
    // also runs: 'plaud_only' suppresses it (saves AI credits); 'keep_both'
    // also transcribes so both coexist for comparison.
    transcriptMode: varchar("transcript_mode", { length: 20 })
        .notNull()
        .default("plaud_only"), // 'plaud_only' | 'keep_both'
    // Which transcript is primary in singular contexts (recording detail,
    // summary input, v1 `transcript`, webhooks) when multiple sources exist.
    preferredTranscriptSource: varchar("preferred_transcript_source", {
        length: 20,
    })
        .notNull()
        .default("plaud"), // 'plaud' | 'riffado'
    // Authoritative default transcription provider: an api_credentials id,
    // the managed "riffado-included" sentinel, or null (no explicit choice
    // -> hosted managed fallback). Supersedes the per-row
    // api_credentials.is_default_transcription boolean for selection.
    defaultTranscriptionProviderId: text("default_transcription_provider_id"),
    // Display/UI settings
    dateTimeFormat: varchar("date_time_format", { length: 20 })
        .notNull()
        .default("relative"), // 'relative', 'absolute', 'iso'
    recordingListSortOrder: varchar("recording_list_sort_order", { length: 20 })
        .notNull()
        .default("newest"), // 'newest', 'oldest', 'name'
    itemsPerPage: integer("items_per_page").notNull().default(50),
    // Recording list row density: 'comfortable' (2-line, current) or 'compact' (1-line)
    listDensity: varchar("list_density", { length: 20 })
        .notNull()
        .default("comfortable"),
    theme: varchar("theme", { length: 20 }).notNull().default("system"), // 'light', 'dark', 'system'
    // Storage settings
    autoDeleteRecordings: boolean("auto_delete_recordings")
        .notNull()
        .default(false),
    retentionDays: integer("retention_days"), // nullable, range: 1-365
    // Which kinds of data the retention sweep removes once a recording is
    // older than `retentionDays`. Independent on purpose: keeping only the
    // summary and dropping the audio and transcript is a legitimate policy,
    // as is keeping the text and reclaiming the (much larger) audio.
    //
    // All three default to false, audio included. `auto_delete_recordings`
    // existed for a long time with nothing acting on it, so an instance may
    // well have it switched on from a user who saw no effect and moved on.
    // Defaulting audio to true would turn that dormant toggle into real
    // deletion on the first boot after upgrading. Instead the sweep no-ops
    // until a kind is explicitly selected, and the UI pre-ticks audio when
    // the toggle is first enabled so arming it is a deliberate act.
    retentionDeleteAudio: boolean("retention_delete_audio")
        .notNull()
        .default(false),
    retentionDeleteTranscript: boolean("retention_delete_transcript")
        .notNull()
        .default(false),
    retentionDeleteSummary: boolean("retention_delete_summary")
        .notNull()
        .default(false),
    // Notification settings
    browserNotifications: boolean("browser_notifications")
        .notNull()
        .default(true),
    emailNotifications: boolean("email_notifications").notNull().default(false),
    barkNotifications: boolean("bark_notifications").notNull().default(false),
    notificationSound: boolean("notification_sound").notNull().default(true),
    notificationEmail: varchar("notification_email", { length: 255 }), // nullable, for email notifications
    barkPushUrl: text("bark_push_url"), // nullable, full Bark push URL (e.g., https://api.day.app/your_key)
    // Export/Backup settings
    defaultExportFormat: varchar("default_export_format", { length: 10 })
        .notNull()
        .default("json"), // 'json', 'txt', 'srt', 'vtt'
    // Unused. Backed a permanently disabled "Auto-export new recordings"
    // switch that was never implemented -- it had no destination to export
    // to, and the two sidecar flags below are the working version of the
    // idea. Kept (rather than dropped) so the settings API payload is
    // unchanged and no destructive migration is needed; nothing reads it.
    autoExport: boolean("auto_export").notNull().default(false),
    // Write source-specific `<recording>.<source>.transcript.md` and summary files.
    // sidecar next to the audio file in storage after each successful run.
    autoExportTranscript: boolean("auto_export_transcript")
        .notNull()
        .default(false),
    autoExportSummary: boolean("auto_export_summary").notNull().default(false),
    backupFrequency: varchar("backup_frequency", { length: 20 }), // nullable, 'daily', 'weekly', 'monthly', 'never'
    // Default providers (for quick selection)
    defaultProviders: jsonb("default_providers"), // { transcription: 'openai', enhancement: 'claude' }
    // Onboarding
    onboardingCompleted: boolean("onboarding_completed")
        .notNull()
        .default(false),
    // Title generation
    autoGenerateTitle: boolean("auto_generate_title").notNull().default(true),
    syncTitleToPlaud: boolean("sync_title_to_plaud").notNull().default(false),
    // Title generation prompt configuration
    titleGenerationPrompt: jsonb("title_generation_prompt"), // { preset: string, customPrompt?: string }
    // Summary prompt configuration
    summaryPrompt: jsonb("summary_prompt"), // { selectedPrompt: string, customPrompts: CustomPrompt[] }
    // AI output language (applies to summaries and AI-generated titles).
    // null or "auto" => match transcript language (default behavior).
    aiOutputLanguage: text("ai_output_language"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const apiKeySourceEnum = pgEnum("api_key_source", [
    "manual",
    "device-flow",
]);

export const apiKeys = pgTable(
    "api_keys",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        name: text("name").notNull(),
        keyHash: text("key_hash").notNull().unique(),
        keyPrefix: varchar("key_prefix", { length: 16 }).notNull(),
        source: apiKeySourceEnum("source").notNull().default("manual"),
        scopes: jsonb("scopes").$type<string[]>().notNull().default(["read"]),
        lastUsedAt: timestamp("last_used_at"),
        expiresAt: timestamp("expires_at"),
        revokedAt: timestamp("revoked_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        userIdIdx: index("api_keys_user_id_idx").on(table.userId),
        // No explicit index on `key_hash`: the unique constraint above
        // already creates an implicit btree index Postgres uses for the
        // `where key_hash = ?` lookup in `authenticateRequest`. A second
        // explicit index would just double the write cost on every issue
        // / revoke.
    }),
);

export const webhookEndpoints = pgTable(
    "webhook_endpoints",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        // Encrypted target URL. Receiver URLs can contain path/query secrets.
        url: text("url").notNull(),
        secret: text("secret").notNull(),
        events: jsonb("events").$type<string[]>().notNull(),
        description: text("description"),
        enabled: boolean("enabled").notNull().default(true),
        lastDeliveryAt: timestamp("last_delivery_at"),
        lastDeliveryStatus: varchar("last_delivery_status", {
            length: 16,
        }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        userIdIdx: index("webhook_endpoints_user_id_idx").on(table.userId),
    }),
);

export const webhookDeliveries = pgTable(
    "webhook_deliveries",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        endpointId: text("endpoint_id")
            .notNull()
            .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        recordingId: text("recording_id").references(() => recordings.id, {
            onDelete: "cascade",
        }),
        event: varchar("event", { length: 64 }).notNull(),
        payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
        status: varchar("status", { length: 16 }).notNull(),
        attempts: integer("attempts").notNull().default(0),
        lastAttemptAt: timestamp("last_attempt_at"),
        nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
        lastResponseStatus: integer("last_response_status"),
        lastResponseBody: text("last_response_body"),
        lastError: text("last_error"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        pendingScanIdx: index("webhook_deliveries_pending_idx").on(
            table.status,
            table.nextAttemptAt,
        ),
        endpointIdIdx: index("webhook_deliveries_endpoint_id_idx").on(
            table.endpointId,
        ),
        recordingIdIdx: index("webhook_deliveries_recording_id_idx").on(
            table.recordingId,
        ),
    }),
);

export const exportJobStatusEnum = pgEnum("export_job_status", [
    "pending",
    "processing",
    "completed",
    "failed",
]);

/**
 * A queued request to build a full-data archive (audio + transcript +
 * summary per recording, zipped) for one user. Built asynchronously by
 * the worker in `src/lib/export/worker.ts` -- creating this row must
 * stay cheap; all the heavy lifting (streaming audio out of storage,
 * zipping, streaming the archive back into storage) happens off the
 * request thread.
 *
 * `storageKey` + `expiresAt` are only set once `status = 'completed'`.
 * The cleanup pass in the same worker deletes the archive from storage
 * and the row once `expiresAt` has passed, so archives don't accumulate
 * storage cost indefinitely.
 */
export const exportJobs = pgTable(
    "export_jobs",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        status: exportJobStatusEnum("status").notNull().default("pending"),
        storageKey: text("storage_key"),
        // bigint, not integer: a full-library archive (audio for every
        // recording, uncompressed) can exceed 2^31-1 bytes (~2GB) well
        // within the hosted_pro 50GB storage cap.
        fileSize: bigint("file_size", { mode: "number" }),
        recordingCount: integer("recording_count"),
        errorMessage: text("error_message"),
        // Bumped on every failed build attempt. Once it reaches the
        // worker's max-attempts constant, a failure sticks as `failed`
        // instead of being requeued to `pending` -- bounds retries for a
        // job that's failing for a durable reason (not just a transient
        // blip) instead of retrying it forever.
        attempts: integer("attempts").notNull().default(0),
        // Random token stamped on every claim (`claimPendingExportJobs`).
        // A worker may only complete/fail the specific claim it holds --
        // every write is scoped `where id = ... and claim_token = ...`.
        // This is what makes the stale-processing reclaim safe even
        // though it can't distinguish "process crashed" from "still
        // running, just slow": if a reclaimed job's original (zombie)
        // worker eventually finishes and tries to write, its claim token
        // no longer matches (the reclaim cleared it), so the write
        // affects zero rows instead of corrupting whatever the new
        // claim has since done with the job.
        claimToken: text("claim_token"),
        // Storage keys from abandoned attempts (per-claim-token keys --
        // see `claimToken` above -- from claims reclaimed as stale,
        // i.e. the worker holding them almost certainly crashed
        // mid-build). Nothing else ever looks these up once the claim
        // is cleared, so without tracking them here they'd be permanent
        // storage leaks: `reclaimStaleProcessingExportJobs` appends the
        // abandoned key here before clearing `claimToken`, and the
        // worker's cleanup pass sweeps + clears entries from this list
        // once the underlying object is actually deleted.
        staleStorageKeys: jsonb("stale_storage_keys")
            .$type<string[]>()
            .notNull()
            .default(sql`'[]'::jsonb`),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        startedAt: timestamp("started_at"),
        completedAt: timestamp("completed_at"),
        expiresAt: timestamp("expires_at"),
    },
    (table) => ({
        userIdIdx: index("export_jobs_user_id_idx").on(table.userId),
        // Claim query scans pending rows oldest-first.
        statusCreatedAtIdx: index("export_jobs_status_created_at_idx").on(
            table.status,
            table.createdAt,
        ),
        // Cleanup pass scans completed rows past expiry.
        expiresAtIdx: index("export_jobs_expires_at_idx").on(table.expiresAt),
        // Enforces "one active job per user" at the database layer --
        // the application-level check-then-insert in POST /api/backup is
        // only a fast path; this index is what actually prevents two
        // concurrent requests from both slipping past that check and
        // enqueuing duplicate jobs.
        userActiveUnique: uniqueIndex("export_jobs_user_active_unique")
            .on(table.userId)
            .where(sql`${table.status} in ('pending', 'processing')`),
    }),
);

export const apiRateLimitBuckets = pgTable(
    "api_rate_limit_buckets",
    {
        key: text("key").primaryKey(),
        count: integer("count").notNull().default(0),
        resetAt: timestamp("reset_at").notNull(),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        resetAtIdx: index("api_rate_limit_buckets_reset_at_idx").on(
            table.resetAt,
        ),
    }),
);

/**
 * Aggregate hit counter for the install.sh routes. Counts every fetch of
 * `/install.sh` and `/{version}/install.sh` on the hosted instance.
 *
 * Privacy: no IP, no User-Agent, no identifier of any kind. Just (day,
 * version) -> count. This is first-party traffic on our own webserver,
 * not user-device storage. Self-host instances do NOT write to this
 * table -- writes are gated on env.IS_HOSTED.
 *
 * Not an instance count. One operator re-running `install.sh` five times
 * is five hits. CI pipelines count every run. Read as a directional
 * trend, not absolute deployments.
 */
export const installScriptHits = pgTable(
    "install_script_hits",
    {
        day: date("day").notNull(),
        /** "latest" for the unversioned route, "vX.Y.Z" for versioned, "invalid" for anything that fails the version regex. */
        version: text("version").notNull(),
        count: integer("count").notNull().default(0),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.day, table.version] }),
    }),
);

export const emailSuppressions = pgTable(
    "email_suppressions",
    {
        email: text("email").primaryKey(),
        reason: varchar("reason", { length: 20 }).notNull(),
        note: text("note"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        createdAtIdx: index("email_suppressions_created_at_idx").on(
            table.createdAt,
        ),
    }),
);

export const emailCampaigns = pgTable("email_campaigns", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => nanoid()),
    slug: text("slug").notNull().unique(),
    subject: text("subject").notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const emailDeliveries = pgTable(
    "email_deliveries",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        campaignId: text("campaign_id")
            .notNull()
            .references(() => emailCampaigns.id, { onDelete: "cascade" }),
        userId: text("user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        subscriberId: text("subscriber_id").references(
            () => newsletterSubscriptions.id,
            { onDelete: "set null" },
        ),
        email: text("email").notNull(),
        status: varchar("status", { length: 30 }).notNull(),
        messageId: text("message_id"),
        error: text("error"),
        sentAt: timestamp("sent_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        campaignEmailUnique: unique(
            "email_deliveries_campaign_email_unique",
        ).on(table.campaignId, table.email),
        campaignStatusIdx: index("email_deliveries_campaign_status_idx").on(
            table.campaignId,
            table.status,
        ),
        userIdIdx: index("email_deliveries_user_id_idx").on(table.userId),
    }),
);

export const emailValidations = pgTable(
    "email_validations",
    {
        email: text("email").primaryKey(),
        reachable: varchar("reachable", { length: 20 }).notNull(),
        isDisposable: boolean("is_disposable").notNull().default(false),
        isRoleAccount: boolean("is_role_account").notNull().default(false),
        hasFullInbox: boolean("has_full_inbox").notNull().default(false),
        isCatchAll: boolean("is_catch_all").notNull().default(false),
        mxAccepts: boolean("mx_accepts").notNull().default(false),
        rawResponse: jsonb("raw_response"),
        provider: varchar("provider", { length: 30 })
            .notNull()
            .default("reacher-stacked"),
        checkedAt: timestamp("checked_at").notNull().defaultNow(),
    },
    (table) => ({
        checkedAtIdx: index("email_validations_checked_at_idx").on(
            table.checkedAt,
        ),
    }),
);

export const newsletterSubscriptions = pgTable(
    "newsletter_subscriptions",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        email: text("email").notNull().unique(),
        source: varchar("source", { length: 20 }).notNull(), // 'landing' | 'install' | 'admin'
        consentedAt: timestamp("consented_at").notNull().defaultNow(),
        confirmedAt: timestamp("confirmed_at"),
        unsubscribedAt: timestamp("unsubscribed_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        confirmedAtIdx: index("newsletter_subscriptions_confirmed_at_idx").on(
            table.confirmedAt,
        ),
    }),
);

export const billingCustomers = pgTable("billing_customers", {
    userId: text("user_id")
        .primaryKey()
        .references(() => users.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").notNull().unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const foundingMemberReservations = pgTable(
    "founding_member_reservations",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        stripeCheckoutSessionId: text("stripe_checkout_session_id").unique(),
        stripePriceId: text("stripe_price_id").notNull(),
        status: foundingMemberReservationStatusEnum("status")
            .notNull()
            .default("reserved"),
        reservedAt: timestamp("reserved_at").notNull().defaultNow(),
        expiresAt: timestamp("expires_at").notNull(),
        consumedAt: timestamp("consumed_at"),
        releasedAt: timestamp("released_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        statusExpiresAtIdx: index(
            "founding_member_reservations_status_expires_at_idx",
        ).on(table.status, table.expiresAt),
        userStatusIdx: index("founding_member_reservations_user_status_idx").on(
            table.userId,
            table.status,
        ),
        userReservedUnique: uniqueIndex(
            "founding_member_reservations_user_reserved_unique",
        )
            .on(table.userId)
            .where(sql`${table.status} = 'reserved'`),
    }),
);

export const subscriptions = pgTable(
    "subscriptions",
    {
        id: text("id").primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        stripeCustomerId: text("stripe_customer_id").notNull(),
        stripePriceId: text("stripe_price_id"),
        status: varchar("status", { length: 24 }).notNull(),
        amountValue: text("amount_value").notNull(),
        amountCurrency: varchar("amount_currency", { length: 3 }).notNull(),
        interval: text("interval").notNull(),
        description: text("description"),
        /** ISO-3166-1 alpha-2 billing country, for our own VAT-OSS records. */
        billingCountry: varchar("billing_country", { length: 2 }),
        startDate: timestamp("start_date"),
        nextPaymentAt: timestamp("next_payment_at"),
        canceledAt: timestamp("canceled_at"),
        withdrawalWaiverAcceptedAt: timestamp("withdrawal_waiver_accepted_at"),
        metadata: jsonb("metadata"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        userIdActiveUnique: uniqueIndex("subscriptions_user_id_active_unique")
            .on(table.userId)
            .where(sql`${table.status} IN ('active', 'trialing', 'past_due')`),
        userStatusIdx: index("subscriptions_user_status_idx").on(
            table.userId,
            table.status,
        ),
    }),
);

export const stripeWebhookEvents = pgTable(
    "stripe_webhook_events",
    {
        eventId: text("event_id").primaryKey(),
        type: varchar("type", { length: 60 }).notNull(),
        eventCreatedAt: timestamp("event_created_at").notNull(),
        payload: jsonb("payload")
            .$type<Record<string, unknown>>()
            .notNull()
            .default({}),
        // Existing claim-only rows predate the durable inbox and must remain
        // completed on migration; new inbox inserts explicitly set pending.
        status: stripeWebhookEventStatusEnum("status")
            .notNull()
            .default("completed"),
        attempts: integer("attempts").notNull().default(0),
        claimToken: text("claim_token"),
        startedAt: timestamp("started_at"),
        nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
        lastError: text("last_error"),
        completedAt: timestamp("completed_at"),
        failedAt: timestamp("failed_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        dueScanIdx: index("stripe_webhook_events_due_idx").on(
            table.status,
            table.nextAttemptAt,
        ),
        createdAtIdx: index("stripe_webhook_events_created_at_idx").on(
            table.createdAt,
        ),
    }),
);

export const asyncJobStatusEnum = pgEnum("async_job_status", [
    "pending",
    "processing",
    "completed",
    "failed",
]);

/**
 * A unit of work that must survive the process that asked for it.
 *
 * Riffado already had five background workers, but each owned a bespoke
 * table for one job shape. This one is generic on purpose: `kind` selects a
 * handler from the registry in `src/lib/jobs/registry.ts`, so a new kind of
 * durable work (summaries today, knowledge-base construction next) is a
 * handler plus a registration, not another table, another worker and another
 * set of claim/retry/reclaim semantics to get subtly wrong.
 *
 * The reason it exists at all is unattended work. A summary generated
 * automatically after a sync has nobody watching it; a container upgrade
 * midway through it used to mean the work was simply lost, with the user
 * finding out only by noticing a recording that never got a summary. A
 * claimed row whose worker stops heartbeating is reclaimed and retried
 * instead.
 *
 * ## What must never go in here
 *
 * `payload`, `progress` and `result` are plain jsonb -- NOT encrypted, unlike
 * `transcriptions.text` or `ai_enhancements.summary`. So they hold
 * identifiers, counts and provenance, never user content. A handler that
 * produces content writes it to its own (encrypted) home and returns only a
 * description of what it did. `lastError` follows the same rule: it stores
 * the mapped, user-safe `AppError` message, never a raw provider error,
 * which can carry request details or key fragments.
 */
export const asyncJobs = pgTable(
    "async_jobs",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        // varchar, not a pgEnum: this is the extension point. Adding a kind
        // should be a handler registration, and making it an enum would make
        // it a migration as well -- with a window where a newly deployed
        // instance enqueues a kind the not-yet-migrated database rejects.
        kind: varchar("kind", { length: 64 }).notNull(),
        // The domain object this job acts on -- a recording id for a summary.
        // Nullable for kinds with no natural subject (a nightly sweep).
        // Doubles as the dedupe key via `async_jobs_active_unique` below.
        subjectId: text("subject_id"),
        // Higher runs first. Exists so one interactive request does not wait
        // behind a sync's worth of automatic work: a sync can enqueue a dozen
        // auto-summaries, and without this the user who then clicks "Generate
        // summary" is last in line behind all of them.
        priority: integer("priority").notNull().default(0),
        payload: jsonb("payload")
            .$type<Record<string, unknown>>()
            .notNull()
            .default({}),
        status: asyncJobStatusEnum("status").notNull().default("pending"),
        attempts: integer("attempts").notNull().default(0),
        // Per row rather than per kind, so the value a job was enqueued under
        // stays stable even if the handler's default is later changed.
        maxAttempts: integer("max_attempts").notNull().default(3),
        // When this job next becomes claimable. Set forward on a failed
        // attempt to implement backoff (same mechanism as
        // `webhook_deliveries.next_attempt_at`).
        nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
        // Stamped fresh on every claim. Every write the claiming worker makes
        // is scoped to it, so a job reclaimed as stale cannot be corrupted by
        // a late write from the worker that lost it. Same mechanism, and the
        // same reasoning, as `export_jobs.claim_token`.
        claimToken: text("claim_token"),
        // Last progress snapshot the handler reported. Counts and phase
        // names only -- it is what lets a client that reconnects (or a page
        // reloaded after a restart) show where the job actually is rather
        // than starting its spinner from zero.
        progress: jsonb("progress").$type<Record<string, unknown>>(),
        // Provenance of a completed job, never its output. See the class
        // comment above.
        result: jsonb("result").$type<Record<string, unknown>>(),
        lastError: text("last_error"),
        errorCode: varchar("error_code", { length: 64 }),
        // Touched by the running handler. This, not `started_at`, is what
        // distinguishes "the worker died" from "the job is slow": a process
        // killed by a container upgrade stops heartbeating immediately, so
        // the job is reclaimable within a couple of minutes instead of after
        // whatever worst-case duration ceiling the kind allows.
        heartbeatAt: timestamp("heartbeat_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        startedAt: timestamp("started_at"),
        completedAt: timestamp("completed_at"),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        // The claim scan: due rows, best priority first, oldest first within
        // a priority.
        dueScanIdx: index("async_jobs_due_idx").on(
            table.status,
            table.priority,
            table.nextAttemptAt,
        ),
        userIdIdx: index("async_jobs_user_id_idx").on(table.userId),
        // "Is there a job running for this recording?" -- the reattach query.
        subjectIdx: index("async_jobs_kind_subject_idx").on(
            table.kind,
            table.subjectId,
        ),
        // Prune scan over finished rows.
        completedAtIdx: index("async_jobs_completed_at_idx").on(
            table.completedAt,
        ),
        // One live job per (kind, subject). Double-clicking "Generate
        // summary" must not buy two summaries, and an application-level
        // check-then-insert cannot be atomic against a concurrent request
        // racing the same check. Postgres treats NULLs as distinct, so kinds
        // with no subject are deliberately unconstrained by this.
        activeUnique: uniqueIndex("async_jobs_active_unique")
            .on(table.kind, table.subjectId)
            .where(sql`${table.status} in ('pending', 'processing')`),
    }),
);

export const emailLog = pgTable(
    "email_log",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        // Wide enough for namespaced per-object keys such as
        // `payment_failed:<invoiceId>` (prefix + `in_...` id ~= 42 chars).
        kind: varchar("kind", { length: 120 }).notNull(),
        sentAt: timestamp("sent_at").notNull().defaultNow(),
    },
    (table) => ({
        userKindUnique: unique("email_log_user_kind_unique").on(
            table.userId,
            table.kind,
        ),
    }),
);
