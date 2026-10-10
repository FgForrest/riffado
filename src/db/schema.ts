import { sql } from "drizzle-orm";
import {
    type AnyPgColumn,
    bigint,
    boolean,
    check,
    date,
    foreignKey,
    index,
    integer,
    jsonb,
    numeric,
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
export const users = pgTable(
    "users",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        email: text("email").notNull().unique(),
        emailVerified: boolean("email_verified").notNull().default(false),
        name: text("name"),
        uiLocale: varchar("ui_locale", { length: 10 }),
        // 'org' marks the self-host organization account created from
        // ORG_ACCOUNT_EMAIL. It owns the shared Organization tree and the org
        // views of shared recordings, and never owns recordings of its own.
        role: varchar("role", { length: 16 })
            .$type<"user" | "org">()
            .notNull()
            .default("user"),
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
        // The last single sign-on, which keeps the user's mail addresses
        // receiving (MAIL_INACTIVE_DAYS). Null: never, or not since this
        // column came (backfilled from sessions); reads as inactive.
        lastSsoLoginAt: timestamp("last_sso_login_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        // At most one organization account, even when several app processes
        // bootstrap it from the environment at the same moment.
        singleOrgAccount: uniqueIndex("users_single_org_account")
            .on(table.role)
            .where(sql`${table.role} = 'org'`),
    }),
);

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
        adminUserIdx: index("admin_action_log_admin_user_id_idx")
            .on(table.adminUserId)
            .where(sql`${table.adminUserId} is not null`),
        targetUserIdx: index("admin_action_log_target_user_idx").on(
            table.targetUserId,
            table.createdAt,
        ),
    }),
);

export const sessions = pgTable(
    "sessions",
    {
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
    },
    (table) => ({
        userIdIdx: index("sessions_user_id_idx").on(table.userId),
        expiresAtIdx: index("sessions_expires_at_idx").on(table.expiresAt),
    }),
);

export const accounts = pgTable(
    "accounts",
    {
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
        // Better Auth's OAuth account fields. Single sign-on keeps the provider's
        // tokens out of the database, so these stay null; the columns exist
        // because Better Auth writes every field of its account model.
        accessTokenExpiresAt: timestamp("access_token_expires_at"),
        refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
        scope: text("scope"),
        idToken: text("id_token"),
        password: text("password"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        userIdIdx: index("accounts_user_id_idx").on(table.userId),
        // Sign-in by provider looks the account up by (providerId, accountId).
        providerAccountIdx: index("accounts_provider_account_idx").on(
            table.providerId,
            table.accountId,
        ),
    }),
);

// Instance-wide markers for one-time startup work, keyed by a fixed name.
export const instanceState = pgTable("instance_state", {
    key: varchar("key", { length: 64 }).primaryKey(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verifications = pgTable(
    "verifications",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        identifier: text("identifier").notNull(),
        value: text("value").notNull(),
        expiresAt: timestamp("expires_at").notNull(),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        identifierIdx: index("verifications_identifier_idx").on(
            table.identifier,
        ),
        expiresAtIdx: index("verifications_expires_at_idx").on(table.expiresAt),
    }),
);

// Plaud connection
export const plaudConnections = pgTable(
    "plaud_connections",
    {
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
    },
    (table) => ({
        userIdIdx: index("plaud_connections_user_id_idx").on(table.userId),
    }),
);

// OAuth connections to third-party accounts (Google now, Microsoft later).
// Not a sign-in method: better-auth never sees these.
export const oauthConnections = pgTable(
    "oauth_connections",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        provider: varchar("provider", { length: 32 })
            .$type<"google">()
            .notNull(),
        // The provider's stable account id (Google `sub`).
        subject: text("subject").notNull(),
        email: text("email").notNull(),
        // Google Workspace domain (`hd` claim); null for consumer accounts.
        hostedDomain: text("hosted_domain"),
        // Encrypted refresh token.
        refreshToken: text("refresh_token").notNull(),
        // Space-separated scopes the account has granted.
        scopes: text("scopes").notNull(),
        // `needs_reconnect` once the provider rejects the refresh token.
        status: varchar("status", { length: 16 })
            .$type<"active" | "needs_reconnect">()
            .notNull()
            .default("active"),
        lastError: text("last_error"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        userProviderUnique: unique("oauth_connections_user_provider_unique").on(
            table.userId,
            table.provider,
        ),
    }),
);

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
    }),
);

/** What an item of the Chatter pile is: a recording, or a mail message. */
export type ChatterItemKind = "audio" | "mail";

// The Chatter pile: one row per item of any kind, sharing its id with the
// row of its kind (`recordings`, `mail_messages`). Everything that is not
// about one kind (folders, summaries, tasks, Learn, exports) points here.
export const chatterItems = pgTable(
    "chatter_items",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        kind: varchar("kind", { length: 16 })
            .$type<ChatterItemKind>()
            .notNull(),
        // Encrypted: a recording's title, a mail's subject.
        title: text("title").notNull(),
        // When a person last set the title; see the former
        // `recordings.title_edited_at`.
        titleEditedAt: timestamp("title_edited_at"),
        // When it happened: a recording's start, a mail's date.
        occurredAt: timestamp("occurred_at").notNull(),
        // Soft-delete tombstone; the kind's row carries it too.
        deletedAt: timestamp("deleted_at"),
        // Automatic Learn holds the title, summary and topics back until its
        // review is done, and at most until this time; null when nothing is
        // held.
        summaryDueAt: timestamp("summary_due_at"),
        // Retention markers: set when the sweep removed the content (a
        // transcript, a mail's text) or the summary, cleared when it comes
        // back. See `recordings.audio_reaped_at` for why they matter.
        contentReapedAt: timestamp("content_reaped_at"),
        summaryReapedAt: timestamp("summary_reaped_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        // Targets of the kinds' composite foreign keys, so a kind's row can
        // belong only to an item of the same owner and kind.
        idUserUnique: unique("chatter_items_id_user_id_unique").on(
            table.id,
            table.userId,
        ),
        idKindUnique: unique("chatter_items_id_kind_unique").on(
            table.id,
            table.kind,
        ),
        // A user's live pile, newest first.
        userOccurredLiveIdx: index("chatter_items_user_id_occurred_at_live_idx")
            .on(
                table.userId,
                table.occurredAt.desc().nullsFirst(),
                table.id.desc().nullsFirst(),
            )
            .where(sql`${table.deletedAt} is null`),
        // The automatic Learn sweep reads only the few held items.
        summaryDueIdx: index("chatter_items_summary_due_at_idx")
            .on(table.summaryDueAt)
            .where(sql`${table.summaryDueAt} is not null`),
        kindCheck: check(
            "chatter_items_kind_check",
            sql`${table.kind} in ('audio', 'mail')`,
        ),
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
        // Always `audio`: with `userId`, the composite foreign key to the
        // recording's `chatter_items` row.
        kind: varchar("kind", { length: 16 })
            .$type<"audio">()
            .notNull()
            .default("audio"),
        deviceSn: varchar("device_sn", { length: 255 }).notNull(),
        // Unique ID from Plaud API, scoped per Riffado user.
        plaudFileId: varchar("plaud_file_id", { length: 255 }).notNull(),
        // Deprecated (now `chatter_items.title`), see
        // src/db/deprecated-columns.ts.
        deprecatedFilename: text("filename"),
        duration: integer("duration").notNull(), // milliseconds
        // Deprecated (now `chatter_items.occurred_at`).
        deprecatedStartTime: timestamp("start_time"),
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
        // Generated during audio ingest, with a lazy client fallback for
        // existing recordings. Stored as a JSON
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
        // Deprecated (now `chatter_items.summary_due_at`).
        deprecatedSummaryDueAt: timestamp("summary_due_at"),
        // Retention marker of the audio (the transcript's and summary's are
        // on `chatter_items`). Set by the retention sweep
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
        // Deprecated (now `chatter_items.content_reaped_at` and
        // `summary_reaped_at`).
        deprecatedTranscriptReapedAt: timestamp("transcript_reaped_at"),
        deprecatedSummaryReapedAt: timestamp("summary_reaped_at"),
        // DB-backed claim for the external remote-trash operation. The
        // retention worker runs in every app process, so this prevents two
        // processes from moving the same remote original concurrently.
        remoteRetentionClaimedAt: timestamp("remote_retention_claimed_at"),
        // Deprecated, see src/db/deprecated-columns.ts.
        deprecatedUnsharedAt: timestamp("unshared_at"),
        // Deprecated (now `chatter_items.title_edited_at`).
        deprecatedTitleEditedAt: timestamp("title_edited_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        // Every lookup by user alone; goes with the deprecated start time.
        userStartTimeIdx: index("recordings_user_id_start_time_idx").on(
            table.userId,
            table.deprecatedStartTime,
        ),
        // The recording belongs to an `audio` item of the same owner.
        itemUserFk: foreignKey({
            name: "recordings_item_user_fk",
            columns: [table.id, table.userId],
            foreignColumns: [chatterItems.id, chatterItems.userId],
        }).onDelete("cascade"),
        itemKindFk: foreignKey({
            name: "recordings_item_kind_fk",
            columns: [table.id, table.kind],
            foreignColumns: [chatterItems.id, chatterItems.kind],
        }).onDelete("cascade"),
        // The v1 list: a user's live recordings, newest change first.
        userUpdatedLiveIdx: index("recordings_user_id_updated_at_live_idx")
            .on(
                table.userId,
                table.updatedAt.desc().nullsFirst(),
                table.id.desc().nullsFirst(),
            )
            .where(sql`${table.deletedAt} is null`),
        userPlaudFileUnique: unique(
            "recordings_user_id_plaud_file_id_unique",
        ).on(table.userId, table.plaudFileId),
        kindCheck: check("recordings_kind_check", sql`${table.kind} = 'audio'`),
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
        sortOrder: integer("sort_order").notNull().default(0),
        // Optimistic lock for Organization folders, which several people
        // edit at once. Bumped on every rename and move.
        version: integer("version").notNull().default(0),
        // Who created an Organization folder. `userId` is the org account
        // for those, so this is the only trace of the person; set null
        // rather than cascade so their leaving never deletes shared folders.
        createdByUserId: text("created_by_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        parentIdIdx: index("recording_folders_parent_id_idx").on(
            table.parentId,
        ),
        createdByIdx: index("recording_folders_created_by_user_id_idx")
            .on(table.createdByUserId)
            .where(sql`${table.createdByUserId} is not null`),
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
        itemId: text("recording_id")
            .notNull()
            .references(() => chatterItems.id, { onDelete: "cascade" }),
        folderId: text("folder_id")
            .notNull()
            .references(() => recordingFolders.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.itemId, table.folderId] }),
        userIdIdx: index("recording_folder_assignments_user_id_idx").on(
            table.userId,
        ),
        folderIdIdx: index("recording_folder_assignments_folder_id_idx").on(
            table.folderId,
        ),
    }),
);

export const folderExportConfigurations = pgTable(
    "folder_export_configurations",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        folderId: text("folder_id")
            .notNull()
            .references(() => recordingFolders.id, { onDelete: "cascade" }),
        provider: varchar("provider", { length: 32 })
            .$type<"filesystem" | "google-drive">()
            .notNull(),
        exportAudio: boolean("export_audio").notNull().default(true),
        exportTranscript: boolean("export_transcript").notNull().default(true),
        exportSummary: boolean("export_summary").notNull().default(true),
        // The last failure only the user can fix (a revoked account, a
        // deleted target folder); cleared by the next successful plan.
        lastError: text("last_error"),
        lastErrorAt: timestamp("last_error_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        userIdIdx: index("folder_export_configurations_user_id_idx").on(
            table.userId,
        ),
        folderIdIdx: index("folder_export_configurations_folder_id_idx").on(
            table.folderId,
        ),
    }),
);

export const filesystemExportSettings = pgTable(
    "filesystem_export_settings",
    {
        exportConfigurationId: text("export_configuration_id")
            .primaryKey()
            .references(() => folderExportConfigurations.id, {
                onDelete: "cascade",
            }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        targetPath: text("target_path").notNull(),
        // When the files earlier versions wrote were taken into
        // `filesystem_export_nodes`; null until the first plan does it.
        nodesAdoptedAt: timestamp("nodes_adopted_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        userIdIdx: index("filesystem_export_settings_user_id_idx").on(
            table.userId,
        ),
    }),
);

// Files and directories a filesystem export created, by logical path: the
// only entries under the export root it ever moves or deletes.
export const filesystemExportNodes = pgTable(
    "filesystem_export_nodes",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        exportConfigurationId: text("export_configuration_id")
            .notNull()
            .references(() => folderExportConfigurations.id, {
                onDelete: "cascade",
            }),
        logicalPath: text("logical_path").notNull(),
        kind: varchar("kind", { length: 16 })
            .$type<"directory" | "file">()
            .notNull(),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        pathUnique: unique("filesystem_export_nodes_path_unique").on(
            table.exportConfigurationId,
            table.logicalPath,
        ),
        userIdIdx: index("filesystem_export_nodes_user_id_idx").on(
            table.userId,
        ),
    }),
);

export const googleDriveExportSettings = pgTable(
    "google_drive_export_settings",
    {
        exportConfigurationId: text("export_configuration_id")
            .primaryKey()
            .references(() => folderExportConfigurations.id, {
                onDelete: "cascade",
            }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        // Google `sub` of the account that picked the folder: the export
        // writes only through that account.
        accountSubject: text("account_subject").notNull(),
        rootFolderId: text("root_folder_id").notNull(),
        rootFolderName: text("root_folder_name").notNull(),
        // Shared drive holding the folder; null for My Drive.
        driveId: text("drive_id"),
        transcriptFormat: varchar("transcript_format", { length: 16 })
            .$type<"markdown" | "google_doc" | "both">()
            .notNull()
            .default("markdown"),
        summaryFormat: varchar("summary_format", { length: 16 })
            .$type<"markdown" | "google_doc" | "both">()
            .notNull()
            .default("markdown"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        userIdIdx: index("google_drive_export_settings_user_id_idx").on(
            table.userId,
        ),
    }),
);

// Drive items a Google Drive export created, by logical path. A cache: every
// item also carries the export's id in its Drive `appProperties`.
export const driveExportNodes = pgTable(
    "drive_export_nodes",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        exportConfigurationId: text("export_configuration_id")
            .notNull()
            .references(() => folderExportConfigurations.id, {
                onDelete: "cascade",
            }),
        logicalPath: text("logical_path").notNull(),
        driveFileId: text("drive_file_id").notNull(),
        kind: varchar("kind", { length: 16 })
            .$type<"folder" | "file" | "google_doc">()
            .notNull(),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        pathUnique: unique("drive_export_nodes_path_unique").on(
            table.exportConfigurationId,
            table.logicalPath,
        ),
        userIdIdx: index("drive_export_nodes_user_id_idx").on(table.userId),
    }),
);

export const folderExportDirectories = pgTable(
    "folder_export_directories",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        exportConfigurationId: text("export_configuration_id")
            .notNull()
            .references(() => folderExportConfigurations.id, {
                onDelete: "cascade",
            }),
        folderId: text("folder_id")
            .notNull()
            .references(() => recordingFolders.id, { onDelete: "cascade" }),
        targetPath: text("target_path").notNull(),
        directoryName: text("directory_name").notNull(),
        logicalPath: text("logical_path").notNull(),
        expected: boolean("expected").notNull().default(true),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        folderUnique: unique("folder_export_directories_folder_unique").on(
            table.exportConfigurationId,
            table.folderId,
        ),
        expectedPathUnique: uniqueIndex(
            "folder_export_directories_expected_path_unique",
        )
            .on(table.exportConfigurationId, table.logicalPath)
            .where(sql`${table.expected}`),
        userIdIdx: index("folder_export_directories_user_id_idx").on(
            table.userId,
        ),
        folderIdIdx: index("folder_export_directories_folder_id_idx").on(
            table.folderId,
        ),
    }),
);

export const folderExportPlacements = pgTable(
    "folder_export_placements",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        exportConfigurationId: text("export_configuration_id")
            .notNull()
            .references(() => folderExportConfigurations.id, {
                onDelete: "cascade",
            }),
        itemId: text("recording_id")
            .notNull()
            .references(() => chatterItems.id, { onDelete: "cascade" }),
        placementFolderId: text("placement_folder_id")
            .notNull()
            .references(() => recordingFolders.id, { onDelete: "cascade" }),
        targetPath: text("target_path").notNull(),
        directoryName: text("directory_name").notNull(),
        logicalPath: text("logical_path").notNull(),
        expected: boolean("expected").notNull().default(true),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        placementUnique: unique("folder_export_placements_placement_unique").on(
            table.exportConfigurationId,
            table.itemId,
            table.placementFolderId,
        ),
        expectedPathUnique: uniqueIndex(
            "folder_export_placements_expected_path_unique",
        )
            .on(table.exportConfigurationId, table.logicalPath)
            .where(sql`${table.expected}`),
        userIdIdx: index("folder_export_placements_user_id_idx").on(
            table.userId,
        ),
        recordingIdIdx: index("folder_export_placements_recording_id_idx").on(
            table.itemId,
        ),
        placementFolderIdIdx: index(
            "folder_export_placements_placement_folder_id_idx",
        ).on(table.placementFolderId),
    }),
);

export const folderExportMaterializations = pgTable(
    "folder_export_materializations",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        exportConfigurationId: text("export_configuration_id")
            .notNull()
            .references(() => folderExportConfigurations.id, {
                onDelete: "cascade",
            }),
        itemId: text("recording_id")
            .notNull()
            .references(() => chatterItems.id, { onDelete: "cascade" }),
        placementFolderId: text("placement_folder_id")
            .notNull()
            .references(() => recordingFolders.id, { onDelete: "cascade" }),
        artifactType: varchar("artifact_type", { length: 16 })
            .$type<"audio" | "transcript" | "summary">()
            .notNull(),
        artifactId: text("artifact_id").notNull(),
        // `google_doc` only on Google Drive: the Markdown converted to a Doc.
        format: varchar("format", { length: 16 })
            .$type<"file" | "google_doc">()
            .notNull()
            .default("file"),
        artifactVersion: varchar("artifact_version", { length: 64 }).notNull(),
        logicalPath: text("logical_path").notNull(),
        expectedSize: bigint("expected_size", { mode: "number" }).notNull(),
        expected: boolean("expected").notNull().default(true),
        status: varchar("status", { length: 16 })
            .$type<"pending" | "in_progress" | "exported" | "failed">()
            .notNull()
            .default("pending"),
        attempts: integer("attempts").notNull().default(0),
        lastError: text("last_error"),
        exportedAt: timestamp("exported_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        placementUnique: unique(
            "folder_export_materializations_placement_unique",
        ).on(
            table.exportConfigurationId,
            table.placementFolderId,
            table.artifactType,
            table.artifactId,
            table.format,
        ),
        userIdIdx: index("folder_export_materializations_user_id_idx").on(
            table.userId,
        ),
        recordingIdIdx: index(
            "folder_export_materializations_recording_id_idx",
        ).on(table.itemId),
        placementFolderIdIdx: index(
            "folder_export_materializations_placement_folder_id_idx",
        ).on(table.placementFolderId),
        pendingIdx: index("folder_export_materializations_pending_idx")
            .on(table.userId)
            .where(sql`${table.status} = 'pending'`),
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
        // Timed turns, encrypted like the text they were rendered from:
        // diarized speaker turns, or speakerless paragraphs from Whisper's
        // verbose format. Null for providers that report no timings and for
        // every transcript produced before this shipped; `parseSpeakerTurns`
        // over the flat text stays the fallback for those.
        //
        // Written on every upsert, including as NULL -- re-transcribing a
        // diarized recording with an undiarized model has to clear the old
        // turns, or the row keeps a dialog structure its text no longer has.
        // Same reasoning as `ai_enhancements.multi_pass_rounds`.
        turns: jsonb("turns"),
        // Topics detected on this exact transcript, encrypted like `turns`:
        // `StoredTopics`, see lib/topics/stored-topics.ts. Anchored to the
        // times in `turns`, so every write of the transcript rewrites it,
        // as NULL: topics never outlive the transcript they were read from.
        topics: jsonb("topics"),
        // `llmInputFingerprint` of the transcript the topics were detected
        // on (its corrections applied); null before corrections existed.
        topicsInputFingerprint: varchar("topics_input_fingerprint", {
            length: 64,
        }),
        // Who ran the provider. Differs from `userId` when the organization
        // account changes a shared recording: the rows stay the owner's, and
        // the organization account produced (and paid for) them.
        producedByUserId: text("produced_by_user_id").references(
            () => users.id,
            { onDelete: "set null" },
        ),
        // Goes up by one on every write of `text` or `turns`, so anything
        // made from one version of the transcript (a speaker change, a Learn
        // run) can tell it is looking at the version it was made on. Topics
        // are not the transcript and leave it alone.
        revision: integer("revision").notNull().default(0),
        // The md5 of the audio this was made from (`recordings.fileMd5`
        // when it was written). A rewrite over different audio (a Plaud
        // recording trimmed and synced again) shifts the timeline: names
        // are then carried only as suggestions. Null before it was kept.
        audioMd5: varchar("audio_md5", { length: 32 }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        userIdIdx: index("transcriptions_user_id_idx").on(table.userId),
        producedByIdx: index("transcriptions_produced_by_user_id_idx")
            .on(table.producedByUserId)
            .where(sql`${table.producedByUserId} is not null`),
        // At most one transcript per (recording, user, source) so a
        // Plaud-imported transcript and the user's own provider can coexist
        // while each source still upserts cleanly. Also serves every lookup
        // by recording.
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
        // Who first named an Organization person. `userId` is the org account
        // for those, so this is the only trace of the colleague; set null
        // rather than cascade so their leaving keeps the shared record.
        createdByUserId: text("created_by_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        // Postgres treats NULLs as distinct, so any number of people per user
        // may have no email at all -- which is the common case for someone
        // named from a transcript rather than a calendar invite.
        userEmailHashUnique: unique("people_user_id_email_hash_unique").on(
            table.userId,
            table.primaryEmailHash,
        ),
        // A person by email across scopes: whose tasks are assigned to a
        // signed-in user.
        emailHashIdx: index("people_primary_email_hash_idx")
            .on(table.primaryEmailHash)
            .where(sql`${table.primaryEmailHash} is not null`),
        mergedIntoIdx: index("people_merged_into_id_idx")
            .on(table.mergedIntoId)
            .where(sql`${table.mergedIntoId} is not null`),
        createdByIdx: index("people_created_by_user_id_idx")
            .on(table.createdByUserId)
            .where(sql`${table.createdByUserId} is not null`),
    }),
);

// One account's private notes about a person the Organization shares.
//
// Organization people are one record for everyone, but what a colleague
// jotted about someone was written for themselves. Notes therefore stay out
// of the shared row: when a person is promoted, the owner's notes move here,
// visible to that owner alone.
export const personNotes = pgTable(
    "person_notes",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        personId: text("person_id")
            .notNull()
            .references(() => people.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        // Encrypted, like `people.notes`.
        notes: text("notes").notNull(),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        personUserUnique: unique("person_notes_person_id_user_id_unique").on(
            table.personId,
            table.userId,
        ),
        userIdIdx: index("person_notes_user_id_idx").on(table.userId),
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
        // A person looked and could not say who this is. Confirmed with no
        // person, which is an answer; a row with neither is still open.
        markedUnknown: boolean("marked_unknown").notNull().default(false),
        // The human who confirmed this row. Null on machine rows, and on
        // confirmed rows written before this column existed.
        confirmedByUserId: text("confirmed_by_user_id").references(
            () => users.id,
            { onDelete: "set null" },
        ),
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
        confirmedByIdx: index("transcript_speakers_confirmed_by_user_id_idx")
            .on(table.confirmedByUserId)
            .where(sql`${table.confirmedByUserId} is not null`),
    }),
);

// "This speaker is not that person", said by a human about one suggestion.
//
// Kept apart from `transcript_speakers` because a label holds one row: once
// the next suggestion replaced the rejected one, the rejection would be
// forgotten and the same wrong name could come back. Suggestions are
// filtered against this table before they are written.
export const transcriptSpeakerRejections = pgTable(
    "transcript_speaker_rejections",
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
        label: varchar("label", { length: 64 }).notNull(),
        personId: text("person_id")
            .notNull()
            .references(() => people.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        pairUnique: unique("transcript_speaker_rejections_pair_unique").on(
            table.transcriptionId,
            table.label,
            table.personId,
        ),
        personIdx: index("transcript_speaker_rejections_person_id_idx").on(
            table.personId,
        ),
        userIdIdx: index("transcript_speaker_rejections_user_id_idx").on(
            table.userId,
        ),
    }),
);

// Knowledge vocabulary: the kinds of things and relations facts are made of,
// in three layers. Core rows (no owner) ship with the code; the organization
// account's rows are the Organization's shared vocabulary; a user's rows are
// their private vocabulary, visible and usable by them alone.
//
// Non-core keys are generated, never derived from the label: a key is stored
// in the clear, and a private type's name is the user's to keep private.
export const knowledgeEntityTypes = pgTable(
    "knowledge_entity_types",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        // Null for core types.
        userId: text("user_id").references(() => users.id, {
            onDelete: "cascade",
        }),
        key: varchar("key", { length: 64 }).notNull(),
        // Encrypted; core labels are English source strings.
        label: text("label").notNull(),
        // `domainLookupHash("entity-type-label", label)`.
        labelHmac: varchar("label_hmac", { length: 64 }).notNull(),
        status: varchar("status", { length: 16 })
            .$type<"active" | "retired">()
            .notNull()
            .default("active"),
        // Set on a private type when the Organization adopted one of the
        // same name: the user's later facts use the shared key.
        adoptedAsKey: varchar("adopted_as_key", { length: 64 }),
        // An Organization type a share made from a member's private one
        // (Johnny, 2026-09-29): listed first for the curator, until they
        // keep, rename or merge it.
        adoptedFromShare: boolean("adopted_from_share")
            .notNull()
            .default(false),
        // Set on a member's type when the curator deleted the Organization
        // type it was adopted as (Johnny, 2026-09-29): a share adopts it no
        // more, until the Organization has a type of its name, or of the
        // deleted one's (`adoptionRefusedAs`, its `labelHmac`), again.
        adoptionRefusedAt: timestamp("adoption_refused_at"),
        adoptionRefusedAs: varchar("adoption_refused_as", { length: 64 }),
        createdByUserId: text("created_by_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        ownerKeyUnique: unique("knowledge_entity_types_owner_key_unique")
            .on(table.userId, table.key)
            .nullsNotDistinct(),
        ownerLabelUnique: unique("knowledge_entity_types_owner_label_unique")
            .on(table.userId, table.labelHmac)
            .nullsNotDistinct(),
        createdByIdx: index("knowledge_entity_types_created_by_user_id_idx").on(
            table.createdByUserId,
        ),
        adoptedAsIdx: index("knowledge_entity_types_adopted_as_key_idx").on(
            table.adoptedAsKey,
        ),
    }),
);

export const knowledgeRelationTypes = pgTable(
    "knowledge_relation_types",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        // Null for core relations.
        userId: text("user_id").references(() => users.id, {
            onDelete: "cascade",
        }),
        key: varchar("key", { length: 64 }).notNull(),
        // Encrypted; core labels are English source strings.
        label: text("label").notNull(),
        // `domainLookupHash("relation-type-label", label)`.
        labelHmac: varchar("label_hmac", { length: 64 }).notNull(),
        // Entity type keys the subject and the object may have.
        subjectTypes: jsonb("subject_types").$type<string[]>().notNull(),
        objectTypes: jsonb("object_types").$type<string[]>().notNull(),
        // `literal`: the object is text (a role, a definition), not an entity.
        objectKind: varchar("object_kind", { length: 16 })
            .$type<"entity" | "literal">()
            .notNull(),
        // `one`: a subject has at most one object at a time, so a new one
        // replaces the old (asked, never silent).
        cardinality: varchar("cardinality", { length: 8 })
            .$type<"one" | "many">()
            .notNull(),
        status: varchar("status", { length: 16 })
            .$type<"active" | "retired">()
            .notNull()
            .default("active"),
        adoptedAsKey: varchar("adopted_as_key", { length: 64 }),
        // As on entity types.
        adoptedFromShare: boolean("adopted_from_share")
            .notNull()
            .default(false),
        adoptionRefusedAt: timestamp("adoption_refused_at"),
        adoptionRefusedAs: varchar("adoption_refused_as", { length: 64 }),
        createdByUserId: text("created_by_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        ownerKeyUnique: unique("knowledge_relation_types_owner_key_unique")
            .on(table.userId, table.key)
            .nullsNotDistinct(),
        ownerLabelUnique: unique("knowledge_relation_types_owner_label_unique")
            .on(table.userId, table.labelHmac)
            .nullsNotDistinct(),
        createdByIdx: index(
            "knowledge_relation_types_created_by_user_id_idx",
        ).on(table.createdByUserId),
        adoptedAsIdx: index("knowledge_relation_types_adopted_as_key_idx").on(
            table.adoptedAsKey,
        ),
    }),
);

// Relation phrases users suggested to the Organization. Only the phrase
// travels (encrypted), counted once per suggesting user; nothing of the
// facts it came from.
export const knowledgeVocabularyProposals = pgTable(
    "knowledge_vocabulary_proposals",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        phrase: text("phrase").notNull(),
        // `domainLookupHash("vocabulary-phrase", phrase)`.
        phraseHmac: varchar("phrase_hmac", { length: 64 }).notNull(),
        // How many suggested it is counted from the votes, which go with
        // their accounts.
        status: varchar("status", { length: 16 })
            .$type<"open" | "adopted" | "rejected">()
            .notNull()
            .default("open"),
        // The Organization key it was adopted as.
        adoptedAsKey: varchar("adopted_as_key", { length: 64 }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        phraseUnique: unique("knowledge_vocabulary_proposals_phrase_unique").on(
            table.phraseHmac,
        ),
    }),
);

// Who suggested which phrase: counts each user once, and lets a user's
// archive and erasure find what they suggested.
export const knowledgeVocabularyProposalVotes = pgTable(
    "knowledge_vocabulary_proposal_votes",
    {
        proposalId: text("proposal_id")
            .notNull()
            .references(() => knowledgeVocabularyProposals.id, {
                onDelete: "cascade",
            }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.proposalId, table.userId] }),
        userIdIdx: index("knowledge_vocabulary_proposal_votes_user_id_idx").on(
            table.userId,
        ),
    }),
);

// One counter for the whole vocabulary. A Learn run records the version it
// was made with; a change of any type bumps it.
export const knowledgeVocabularyVersion = pgTable(
    "knowledge_vocabulary_version",
    {
        id: integer("id").primaryKey(),
        version: integer("version").notNull().default(0),
    },
);

// Organizations, teams, projects, products, terms, locations and documents
// people talk about. A person is never one: people live in `people`.
export const knowledgeEntities = pgTable(
    "knowledge_entities",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        // The owner: a user, or the organization account for the
        // Organization's.
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        // An entity type's key. Core keys are fixed and every other key is
        // `u_` or `o_` plus a random id, so a key names one type; whether
        // the owner may use it is checked on write.
        typeKey: varchar("type_key", { length: 64 }).notNull(),
        name: text("name").notNull(),
        // `domainLookupHash("entity-name", name)`.
        nameHmac: varchar("name_hmac", { length: 64 }).notNull(),
        description: text("description"),
        // Set on the losing side of a merge; no foreign key, as on people.
        mergedIntoId: text("merged_into_id"),
        createdByUserId: text("created_by_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        // One "Orion" project per scope; tombstones keep their name.
        nameUnique: uniqueIndex("knowledge_entities_owner_type_name_unique")
            .on(table.userId, table.typeKey, table.nameHmac)
            .where(sql`${table.mergedIntoId} is null`),
        mergedIntoIdx: index("knowledge_entities_merged_into_id_idx").on(
            table.mergedIntoId,
        ),
        userIdIdx: index("knowledge_entities_user_id_idx").on(table.userId),
        createdByIdx: index("knowledge_entities_created_by_user_id_idx").on(
            table.createdByUserId,
        ),
        typeKeyIdx: index("knowledge_entities_type_key_idx").on(table.typeKey),
    }),
);

// A user's private description of an Organization entity, as
// `person_notes` is of an Organization person.
export const knowledgeEntityNotes = pgTable(
    "knowledge_entity_notes",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        entityId: text("entity_id")
            .notNull()
            .references(() => knowledgeEntities.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        // Encrypted, like `knowledge_entities.description`.
        notes: text("notes").notNull(),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        entityUserUnique: unique(
            "knowledge_entity_notes_entity_id_user_id_unique",
        ).on(table.entityId, table.userId),
        userIdIdx: index("knowledge_entity_notes_user_id_idx").on(table.userId),
    }),
);

// Other names of a person or an entity. `alias` lasts; `heard_as` is how a
// transcription provider renders the name in one language, taught by the
// correction that put it right, and goes with it.
export const knowledgeAliases = pgTable(
    "knowledge_aliases",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        // The scope: a user's nickname for an Organization person is
        // theirs alone.
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        personId: text("person_id").references(() => people.id, {
            onDelete: "cascade",
        }),
        entityId: text("entity_id").references(() => knowledgeEntities.id, {
            onDelete: "cascade",
        }),
        kind: varchar("kind", { length: 8 })
            .$type<"alias" | "heard_as">()
            .notNull(),
        text: text("text").notNull(),
        // `domainLookupHash("alias", text)`.
        textHmac: varchar("text_hmac", { length: 64 }).notNull(),
        language: varchar("language", { length: 16 }),
        provider: varchar("provider", { length: 64 }),
        correctionId: text("correction_id").references(
            (): AnyPgColumn => transcriptCorrections.id,
            { onDelete: "cascade" },
        ),
        createdByUserId: text("created_by_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        aliasUnique: unique("knowledge_aliases_unique")
            .on(
                table.userId,
                table.personId,
                table.entityId,
                table.kind,
                table.textHmac,
                table.correctionId,
            )
            .nullsNotDistinct(),
        personIdx: index("knowledge_aliases_person_id_idx").on(table.personId),
        entityIdx: index("knowledge_aliases_entity_id_idx").on(table.entityId),
        correctionIdx: index("knowledge_aliases_correction_id_idx").on(
            table.correctionId,
        ),
        oneTarget: check(
            "knowledge_aliases_one_target_check",
            sql`num_nonnulls(${table.personId}, ${table.entityId}) = 1`,
        ),
        kindCheck: check(
            "knowledge_aliases_kind_check",
            sql`${table.kind} in ('alias', 'heard_as')`,
        ),
        taughtBy: check(
            "knowledge_aliases_heard_as_check",
            sql`(${table.kind} = 'heard_as') = (${table.correctionId} is not null)`,
        ),
        createdByIdx: index("knowledge_aliases_created_by_user_id_idx").on(
            table.createdByUserId,
        ),
    }),
);

// Corrections accepted on a transcript: an overlay, so the stored text
// never changes and reverting deletes the row. Anchored to a turn and
// character offsets of one revision; a rewrite of the transcript re-anchors
// them (`recheckCorrectionsInTx`) or drops them.
export const transcriptCorrections = pgTable(
    "transcript_corrections",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        // The scope that made it: the transcript's owner on a private
        // recording, the organization account on a shared one.
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        transcriptionId: text("transcription_id")
            .notNull()
            .references(() => transcriptions.id, { onDelete: "cascade" }),
        transcriptRevision: integer("transcript_revision").notNull(),
        turnIndex: integer("turn_index").notNull(),
        // UTF-16 offsets into the turn's text, as JavaScript slices it.
        charStart: integer("char_start").notNull(),
        charEnd: integer("char_end").notNull(),
        heard: text("heard").notNull(),
        // `domainLookupHash("correction-heard", heard)`.
        heardHmac: varchar("heard_hmac", { length: 64 }).notNull(),
        // `correct` replaces what was heard; `link` keeps it as spoken
        // (a nickname, slang) and points at who or what it means; `fix` is
        // the correction pass's: what was heard put right, of a record or
        // of any misheard words, never teaching how a name is heard.
        kind: varchar("kind", { length: 8 })
            .$type<"correct" | "link" | "fix">()
            .notNull(),
        // A person or an entity (CHECK); none on a `fix` of plain words.
        // Erasing either deletes the corrections targeting them.
        targetPersonId: text("target_person_id").references(() => people.id, {
            onDelete: "cascade",
        }),
        targetEntityId: text("target_entity_id").references(
            (): AnyPgColumn => knowledgeEntities.id,
            { onDelete: "cascade" },
        ),
        // In the transcript's language. Null on a link, which shows the
        // target's current name.
        replacement: text("replacement"),
        // Accepted by default in a review not yet finished.
        preTicked: boolean("pre_ticked").notNull().default(false),
        // The correction pass that made a `fix`.
        passId: text("pass_id").references(
            (): AnyPgColumn => transcriptCorrectionPasses.id,
            { onDelete: "set null" },
        ),
        createdByUserId: text("created_by_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        transcriptIdx: index("transcript_corrections_transcription_id_idx").on(
            table.transcriptionId,
        ),
        passIdx: index("transcript_corrections_pass_id_idx").on(table.passId),
        userIdIdx: index("transcript_corrections_user_id_idx").on(table.userId),
        targetPersonIdx: index(
            "transcript_corrections_target_person_id_idx",
        ).on(table.targetPersonId),
        targetEntityIdx: index(
            "transcript_corrections_target_entity_id_idx",
        ).on(table.targetEntityId),
        oneTarget: check(
            "transcript_corrections_one_target_check",
            sql`num_nonnulls(${table.targetPersonId}, ${table.targetEntityId}) = 1 or (${table.kind} = 'fix' and ${table.targetPersonId} is null and ${table.targetEntityId} is null)`,
        ),
        replacementForCorrect: check(
            "transcript_corrections_replacement_check",
            sql`(${table.kind} in ('correct', 'fix')) = (${table.replacement} is not null)`,
        ),
        kindCheck: check(
            "transcript_corrections_kind_check",
            sql`${table.kind} in ('correct', 'link', 'fix')`,
        ),
        spanCheck: check(
            "transcript_corrections_span_check",
            sql`${table.charStart} >= 0 and ${table.charStart} < ${table.charEnd}`,
        ),
        createdByIdx: index("transcript_corrections_created_by_user_id_idx").on(
            table.createdByUserId,
        ),
    }),
);

// A confirmed fact: subject, relation, object. It lives in a scope (a
// user's private layer, or the Organization's) and, unless a person
// entered it by hand, lasts while evidence for it does.
export const knowledgeFacts = pgTable(
    "knowledge_facts",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        subjectPersonId: text("subject_person_id").references(() => people.id, {
            onDelete: "cascade",
        }),
        subjectEntityId: text("subject_entity_id").references(
            () => knowledgeEntities.id,
            { onDelete: "cascade" },
        ),
        // A relation type's key; like entity type keys, one key names one
        // type.
        relationKey: varchar("relation_key", { length: 64 }).notNull(),
        objectPersonId: text("object_person_id").references(() => people.id, {
            onDelete: "cascade",
        }),
        objectEntityId: text("object_entity_id").references(
            () => knowledgeEntities.id,
            { onDelete: "cascade" },
        ),
        // Encrypted text, on relations whose object is text (a role).
        objectLiteral: text("object_literal"),
        // `p:<id>` or `e:<id>`; the object's may also be `l:` plus
        // `domainLookupHash("fact-literal", literal)`.
        subjectKey: varchar("subject_key", { length: 80 }).notNull(),
        objectKey: varchar("object_key", { length: 80 }).notNull(),
        // Where it was learned: a recording, a mail, or by hand.
        origin: varchar("origin", { length: 16 })
            .$type<"recording" | "mail" | "manual">()
            .notNull(),
        // On a single-valued relation, the fact that took this one's place.
        replacedByFactId: text("replaced_by_fact_id").references(
            (): AnyPgColumn => knowledgeFacts.id,
            { onDelete: "set null" },
        ),
        createdByUserId: text("created_by_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        factUnique: unique("knowledge_facts_unique").on(
            table.userId,
            table.subjectKey,
            table.relationKey,
            table.objectKey,
        ),
        subjectPersonIdx: index("knowledge_facts_subject_person_id_idx").on(
            table.subjectPersonId,
        ),
        subjectEntityIdx: index("knowledge_facts_subject_entity_id_idx").on(
            table.subjectEntityId,
        ),
        objectPersonIdx: index("knowledge_facts_object_person_id_idx").on(
            table.objectPersonId,
        ),
        objectEntityIdx: index("knowledge_facts_object_entity_id_idx").on(
            table.objectEntityId,
        ),
        replacedByIdx: index("knowledge_facts_replaced_by_fact_id_idx").on(
            table.replacedByFactId,
        ),
        oneSubject: check(
            "knowledge_facts_one_subject_check",
            sql`num_nonnulls(${table.subjectPersonId}, ${table.subjectEntityId}) = 1`,
        ),
        oneObject: check(
            "knowledge_facts_one_object_check",
            sql`num_nonnulls(${table.objectPersonId}, ${table.objectEntityId}, ${table.objectLiteral}) = 1`,
        ),
        originCheck: check(
            "knowledge_facts_origin_check",
            sql`${table.origin} in ('recording', 'mail', 'manual')`,
        ),
        createdByIdx: index("knowledge_facts_created_by_user_id_idx").on(
            table.createdByUserId,
        ),
        relationKeyIdx: index("knowledge_facts_relation_key_idx").on(
            table.relationKey,
        ),
        userRelationKeyIdx: index(
            "knowledge_facts_user_id_relation_key_idx",
        ).on(table.userId, table.relationKey),
        subjectKeyIdx: index("knowledge_facts_subject_key_idx").on(
            table.subjectKey,
        ),
        objectKeyIdx: index("knowledge_facts_object_key_idx").on(
            table.objectKey,
        ),
    }),
);

// Where a fact was said: a stretch of one transcript's audio time, with the
// words a person confirmed there. Goes with the transcript.
export const knowledgeFactEvidence = pgTable(
    "knowledge_fact_evidence",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        // The fact's scope.
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        factId: text("fact_id")
            .notNull()
            .references(() => knowledgeFacts.id, { onDelete: "cascade" }),
        // The transcript of a time anchor; null on a text anchor.
        transcriptionId: text("transcription_id").references(
            () => transcriptions.id,
            { onDelete: "cascade" },
        ),
        itemId: text("recording_id")
            .notNull()
            .references(() => chatterItems.id, { onDelete: "cascade" }),
        // The revision of the content (a transcript, a mail's parse) the
        // anchor was confirmed on.
        transcriptRevision: integer("transcript_revision").notNull(),
        // Where it was said: a stretch of audio time, or a range of one
        // segment's text (UTF-16 offsets). Exactly one form is set.
        startMs: integer("start_ms"),
        endMs: integer("end_ms"),
        segmentIndex: integer("segment_index"),
        charStart: integer("char_start"),
        charEnd: integer("char_end"),
        // The label whose speaker the fact is about, when it is (`Speaker 1
        // said "I lead Orion"`): renaming that speaker puts it to review.
        speakerLabel: varchar("speaker_label", { length: 64 }),
        dependsOnSpeaker: boolean("depends_on_speaker")
            .notNull()
            .default(false),
        quote: text("quote").notNull(),
        status: varchar("status", { length: 16 })
            .$type<"supported" | "wording_changed" | "speaker_changed">()
            .notNull()
            .default("supported"),
        confirmedByUserId: text("confirmed_by_user_id").references(
            () => users.id,
            { onDelete: "set null" },
        ),
        confirmedAt: timestamp("confirmed_at").notNull().defaultNow(),
    },
    (table) => ({
        // A time anchor is one per fact and stretch of a transcript; NULLs
        // are distinct, so a text anchor never collides here.
        evidenceUnique: unique("knowledge_fact_evidence_unique").on(
            table.factId,
            table.transcriptionId,
            table.startMs,
            table.endMs,
        ),
        textEvidenceUnique: uniqueIndex("knowledge_fact_evidence_text_unique")
            .on(
                table.factId,
                table.itemId,
                table.segmentIndex,
                table.charStart,
                table.charEnd,
            )
            .where(sql`${table.segmentIndex} is not null`),
        transcriptIdx: index("knowledge_fact_evidence_transcription_id_idx").on(
            table.transcriptionId,
        ),
        recordingIdx: index("knowledge_fact_evidence_recording_id_idx").on(
            table.itemId,
        ),
        userIdIdx: index("knowledge_fact_evidence_user_id_idx").on(
            table.userId,
        ),
        statusCheck: check(
            "knowledge_fact_evidence_status_check",
            sql`${table.status} in ('supported', 'wording_changed', 'speaker_changed')`,
        ),
        rangeCheck: check(
            "knowledge_fact_evidence_range_check",
            sql`${table.startMs} >= 0 and ${table.startMs} <= ${table.endMs}`,
        ),
        anchorCheck: check(
            "knowledge_fact_evidence_anchor_check",
            sql`(${table.transcriptionId} is not null and ${table.startMs} is not null and ${table.endMs} is not null and ${table.segmentIndex} is null and ${table.charStart} is null and ${table.charEnd} is null) or (${table.startMs} is null and ${table.endMs} is null and ${table.segmentIndex} >= 0 and ${table.charStart} >= 0 and ${table.charStart} < ${table.charEnd})`,
        ),
        confirmedByIdx: index(
            "knowledge_fact_evidence_confirmed_by_user_id_idx",
        ).on(table.confirmedByUserId),
    }),
);

// One counter per knowledge scope (a user, or the organization account),
// moved by every transaction that changes what the scope knows: a process
// holding the scope in memory reloads it when the counter moved.
export const knowledgeScopeGenerations = pgTable(
    "knowledge_scope_generations",
    {
        userId: text("user_id")
            .primaryKey()
            .references(() => users.id, { onDelete: "cascade" }),
        generation: bigint("generation", { mode: "number" })
            .notNull()
            .default(0),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
);

// Meaning, as numbers: one vector per entity (its name, type and
// description) or current fact ("subject relation object"), in its scope,
// for one vector generation (the model and how the text was rendered).
// Encrypted, and gone with what it was made from.
export const knowledgeVectors = pgTable(
    "knowledge_vectors",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        entityId: text("entity_id").references(() => knowledgeEntities.id, {
            onDelete: "cascade",
        }),
        factId: text("fact_id").references(() => knowledgeFacts.id, {
            onDelete: "cascade",
        }),
        vectorGeneration: varchar("vector_generation", {
            length: 160,
        }).notNull(),
        dim: integer("dim").notNull(),
        // `encodeVector`, then encrypted.
        vector: text("vector").notNull(),
        // `domainLookupHash("vector-input", rendered text)`: an unchanged
        // item is not embedded again.
        inputHmac: varchar("input_hmac", { length: 64 }).notNull(),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        // With its scope: after a promotion the Organization's vector of an
        // entity is a row of its own beside the former owner's.
        itemUnique: unique("knowledge_vectors_item_unique")
            .on(
                table.userId,
                table.entityId,
                table.factId,
                table.vectorGeneration,
            )
            .nullsNotDistinct(),
        entityIdx: index("knowledge_vectors_entity_id_idx").on(table.entityId),
        factIdx: index("knowledge_vectors_fact_id_idx").on(table.factId),
        oneItem: check(
            "knowledge_vectors_one_item_check",
            sql`num_nonnulls(${table.entityId}, ${table.factId}) = 1`,
        ),
    }),
);

// Per scope: which vector generation is searched, and how far its vectors
// are up to date (the scope generation they were last brought up to).
export const knowledgeVectorState = pgTable("knowledge_vector_state", {
    userId: text("user_id")
        .primaryKey()
        .references(() => users.id, { onDelete: "cascade" }),
    activeGeneration: varchar("active_generation", { length: 160 }),
    embeddedAt: bigint("embedded_at", { mode: "number" }),
    // Moved whenever the vectors change, so a process holding the scope in
    // memory reloads them. Apart from the scope generation, which an
    // embedding run must not move: that would queue the run again.
    vectorVersion: integer("vector_version").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// One Learn pass over one transcript (Phase 3). `userId` is the recording's
// owner, whose rows it reads; `scopeUserId` the scope it proposes knowledge
// in: the owner's on a private recording, the Organization's on a shared
// one. Only counts and provenance here: what it found is in its review
// items, encrypted.
export const learnRuns = pgTable(
    "learn_runs",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        scopeUserId: text("scope_user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        itemId: text("recording_id")
            .notNull()
            .references(() => chatterItems.id, { onDelete: "cascade" }),
        // The transcript a run on a recording read; null on other kinds.
        transcriptionId: text("transcription_id").references(
            () => transcriptions.id,
            { onDelete: "cascade" },
        ),
        view: varchar("view", { length: 16 })
            .$type<"private" | "org">()
            .notNull(),
        // Who asked: the owner, or the organization account.
        actorUserId: text("actor_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        trigger: varchar("trigger", { length: 16 })
            .$type<"manual" | "auto">()
            .notNull(),
        // The revision of the content it read.
        transcriptRevision: integer("transcript_revision").notNull(),
        vocabularyVersion: integer("vocabulary_version").notNull(),
        status: varchar("status", { length: 16 })
            .$type<
                | "queued"
                | "running"
                | "ready"
                | "finished"
                | "failed"
                | "superseded"
                | "cancelled"
            >()
            .notNull()
            .default("queued"),
        // How it ran: the bridge with tools, or the no-tools fallback.
        path: varchar("path", { length: 16 }).$type<"bridge" | "fallback">(),
        provider: varchar("provider", { length: 100 }),
        model: varchar("model", { length: 100 }),
        jobId: text("job_id"),
        // Counts only (items kept per kind, drops per reason, tool calls).
        stats: jsonb("stats").$type<Record<string, number>>(),
        errorCode: varchar("error_code", { length: 64 }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        startedAt: timestamp("started_at"),
        finishedAt: timestamp("finished_at"),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        recordingIdx: index("learn_runs_recording_id_idx").on(table.itemId),
        transcriptionIdx: index("learn_runs_transcription_id_idx").on(
            table.transcriptionId,
        ),
        userIdx: index("learn_runs_user_id_idx").on(table.userId),
        scopeIdx: index("learn_runs_scope_user_id_idx").on(table.scopeUserId),
        actorIdx: index("learn_runs_actor_user_id_idx").on(table.actorUserId),
        // The review badge: recordings with a run waiting for review.
        readyIdx: index("learn_runs_ready_idx")
            .on(table.view, table.userId, table.itemId)
            .where(sql`${table.status} = 'ready'`),
        statusCheck: check(
            "learn_runs_status_check",
            sql`${table.status} in ('queued', 'running', 'ready', 'finished', 'failed', 'superseded', 'cancelled')`,
        ),
        viewCheck: check(
            "learn_runs_view_check",
            sql`${table.view} in ('private', 'org')`,
        ),
    }),
);

// A correction pass: after a Learn run finished, the Learn model reads the
// whole transcript again with the Almanac and puts misheard words right
// (`transcript_corrections` of kind `fix`). Its token for Riffado's tools
// names this row, valid while it runs.
export const transcriptCorrectionPasses = pgTable(
    "transcript_correction_passes",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        // The transcript's owner.
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        // Whose corrections it writes: the owner's, or the Organization's.
        scopeUserId: text("scope_user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        recordingId: text("recording_id")
            .notNull()
            .references(() => recordings.id, { onDelete: "cascade" }),
        transcriptionId: text("transcription_id")
            .notNull()
            .references(() => transcriptions.id, { onDelete: "cascade" }),
        transcriptRevision: integer("transcript_revision").notNull(),
        // The Learn run whose end started it.
        learnRunId: text("learn_run_id").references(() => learnRuns.id, {
            onDelete: "set null",
        }),
        view: varchar("view", { length: 16 })
            .$type<"private" | "org">()
            .notNull(),
        // Who pays: the owner, or the organization account.
        actorUserId: text("actor_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        status: varchar("status", { length: 16 })
            .$type<
                | "queued"
                | "running"
                | "finished"
                | "failed"
                | "superseded"
                | "cancelled"
            >()
            .notNull()
            .default("queued"),
        path: varchar("path", { length: 16 }).$type<"bridge" | "fallback">(),
        provider: varchar("provider", { length: 100 }),
        model: varchar("model", { length: 100 }),
        jobId: text("job_id"),
        // Counts only (fixes written, drops per reason, tool calls).
        stats: jsonb("stats").$type<Record<string, number>>(),
        errorCode: varchar("error_code", { length: 64 }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        startedAt: timestamp("started_at"),
        finishedAt: timestamp("finished_at"),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        recordingIdx: index("transcript_correction_passes_recording_id_idx").on(
            table.recordingId,
        ),
        transcriptionIdx: index(
            "transcript_correction_passes_transcription_id_idx",
        ).on(table.transcriptionId),
        userIdx: index("transcript_correction_passes_user_id_idx").on(
            table.userId,
        ),
        scopeIdx: index("transcript_correction_passes_scope_user_id_idx").on(
            table.scopeUserId,
        ),
        actorIdx: index("transcript_correction_passes_actor_user_id_idx").on(
            table.actorUserId,
        ),
        learnRunIdx: index("transcript_correction_passes_learn_run_id_idx").on(
            table.learnRunId,
        ),
        statusCheck: check(
            "transcript_correction_passes_status_check",
            sql`${table.status} in ('queued', 'running', 'finished', 'failed', 'superseded', 'cancelled')`,
        ),
        viewCheck: check(
            "transcript_correction_passes_view_check",
            sql`${table.view} in ('private', 'org')`,
        ),
    }),
);

// What a run proposes, for a person to decide on. The payload (names,
// heard words, quotes) is encrypted; the fingerprint is a keyed HMAC, so a
// dismissal can be matched without storing what was dismissed.
export const learnReviewItems = pgTable(
    "learn_review_items",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        runId: text("run_id")
            .notNull()
            .references(() => learnRuns.id, { onDelete: "cascade" }),
        // The run's scope.
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        kind: varchar("kind", { length: 32 })
            .$type<
                | "speaker"
                | "correction"
                | "known_fact"
                | "fact"
                | "relation_phrase"
                | "new_record"
            >()
            .notNull(),
        fingerprintHmac: varchar("fingerprint_hmac", { length: 64 }).notNull(),
        payload: jsonb("payload").notNull(),
        // The default the review opens with: yes unless the person says no.
        preTicked: boolean("pre_ticked").notNull().default(false),
        // The person's draft decision; null until they touch it.
        decision: varchar("decision", { length: 16 }).$type<
            "accepted" | "rejected"
        >(),
        // What they chose with it, encrypted: another person for a speaker,
        // "create as my relation" (with its name and shape) or "suggest to
        // the Organization" for a phrase, another name or type for a new
        // record, or the record the Almanac has that it is.
        choice: jsonb("choice"),
        version: integer("version").notNull().default(0),
        dependsOnLabel: varchar("depends_on_label", { length: 64 }),
        // What finishing the review did with it: applied, rejected, or why
        // a ticked one was skipped (`SkipCode`). Null until then, and on
        // reviews finished before it was kept.
        outcome: varchar("outcome", { length: 32 }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        runIdx: index("learn_review_items_run_id_idx").on(table.runId),
        userIdx: index("learn_review_items_user_id_idx").on(table.userId),
        kindCheck: check(
            "learn_review_items_kind_check",
            sql`${table.kind} in ('speaker', 'correction', 'known_fact', 'fact', 'relation_phrase', 'new_record')`,
        ),
    }),
);

// What a person said no to on a recording, so the next run there does not
// propose it again, Re-learn included. A keyed HMAC of the item's
// fingerprint, nothing readable. A new record they rejected outright is
// not proposed on any recording of the scope (`scopeWide`); the recording
// is where they rejected it, so forgetting that recording's rejections
// (or deleting it, or withdrawing it from the Organization) forgets it
// too.
export const learnDismissals = pgTable(
    "learn_dismissals",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        // The scope the item was proposed in.
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        itemId: text("recording_id")
            .notNull()
            .references(() => chatterItems.id, { onDelete: "cascade" }),
        fingerprintHmac: varchar("fingerprint_hmac", { length: 64 }).notNull(),
        scopeWide: boolean("scope_wide").notNull().default(false),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        unique: unique("learn_dismissals_unique").on(
            table.userId,
            table.itemId,
            table.fingerprintHmac,
        ),
        recordingIdx: index("learn_dismissals_recording_id_idx").on(
            table.itemId,
        ),
        scopeWideIdx: index("learn_dismissals_scope_wide_idx")
            .on(table.userId)
            .where(sql`${table.scopeWide}`),
    }),
);

// AI Enhancements
export const aiEnhancements = pgTable(
    "ai_enhancements",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        itemId: text("recording_id")
            .notNull()
            .references(() => chatterItems.id, { onDelete: "cascade" }),
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
        // `llmInputFingerprint` of the transcript as the model read it (its
        // corrections applied); null for a summary made before corrections
        // existed, which never reads as stale.
        inputFingerprint: varchar("input_fingerprint", { length: 64 }),
        multiPassRounds: integer("multi_pass_rounds"),
        multiPassUsed: integer("multi_pass_passes_used"),
        multiPassMerged: boolean("multi_pass_merged"),
        // See `transcriptions.producedByUserId`.
        producedByUserId: text("produced_by_user_id").references(
            () => users.id,
            { onDelete: "set null" },
        ),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        userRecordingSourceUnique: unique(
            "ai_enhancements_recording_user_source_unique",
        ).on(table.itemId, table.userId, table.source),
        transcriptionIdIdx: index("ai_enhancements_transcription_id_idx").on(
            table.transcriptionId,
        ),
        userIdIdx: index("ai_enhancements_user_id_idx").on(table.userId),
        producedByIdx: index("ai_enhancements_produced_by_user_id_idx")
            .on(table.producedByUserId)
            .where(sql`${table.producedByUserId} is not null`),
    }),
);

// What a recording's summaries say somebody has to do. A summary proposes
// rows (`proposed`); whoever may change the recording reviews them, and the
// accepted ones are tasks (`open`, `done`, `dropped`). One row from proposal
// to task, so a task keeps its id and its recording. The rows are the
// recording's owner's in both views, like its summary; they go when its
// last summary does.
export const recordingTasks = pgTable(
    "recording_tasks",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        itemId: text("recording_id")
            .notNull()
            .references(() => chatterItems.id, { onDelete: "cascade" }),
        // The recording's owner.
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        status: varchar("status", { length: 16 })
            .$type<"proposed" | "open" | "done" | "dropped">()
            .notNull(),
        // Encrypted.
        text: text("text").notNull(),
        // Who has to do it: a person of the Almanac (the owner's, or the
        // Organization's on a shared recording); null for nobody yet.
        assigneePersonId: text("assignee_person_id").references(
            () => people.id,
            { onDelete: "set null" },
        ),
        // Encrypted: the name heard when no person of the Almanac matched.
        assigneeHint: text("assignee_hint"),
        // The person was matched on a first name alone: check before accepting.
        assigneeCheck: boolean("assignee_check").notNull().default(false),
        dueDate: date("due_date", { mode: "string" }),
        // Encrypted: the deadline as it was said ("by next Friday").
        duePhrase: text("due_phrase"),
        // Encrypted: a few words of the content it was heard or read in.
        quote: text("quote"),
        // Where: a moment of a recording, or a range of a mail segment.
        evidenceStartMs: integer("evidence_start_ms"),
        evidenceSegmentIndex: integer("evidence_segment_index"),
        evidenceCharStart: integer("evidence_char_start"),
        evidenceCharEnd: integer("evidence_char_end"),
        // Where its evidence is a quoted part of a mail, or text from a
        // sender nothing verified: shown with the proposal, which then
        // starts unticked.
        evidenceProvenance: varchar("evidence_provenance", {
            length: 16,
        }).$type<"quoted" | "unverified">(),
        source: varchar("source", { length: 16 })
            .$type<"riffado" | "plaud" | "manual">()
            .notNull(),
        // A proposal's draft: whether accepting the review keeps it.
        ticked: boolean("ticked").notNull().default(true),
        // Order within the recording, as the summary listed them.
        position: integer("position").notNull().default(0),
        version: integer("version").notNull().default(0),
        createdByUserId: text("created_by_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        acceptedAt: timestamp("accepted_at"),
        // Since when its assignee can see it as theirs: accepted, assigned
        // anew, or its recording shared. The assignee's badge counts from it.
        assignedAt: timestamp("assigned_at"),
        acceptedByUserId: text("accepted_by_user_id").references(
            () => users.id,
            { onDelete: "set null" },
        ),
        // The last move between open, done and dropped.
        statusChangedAt: timestamp("status_changed_at"),
        statusChangedByUserId: text("status_changed_by_user_id").references(
            () => users.id,
            { onDelete: "set null" },
        ),
        updatedByUserId: text("updated_by_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        recordingStatusIdx: index("recording_tasks_recording_status_idx").on(
            table.itemId,
            table.status,
        ),
        assigneeIdx: index("recording_tasks_assignee_person_id_idx").on(
            table.assigneePersonId,
        ),
        userStatusIdx: index("recording_tasks_user_status_idx").on(
            table.userId,
            table.status,
        ),
        createdByIdx: index("recording_tasks_created_by_user_id_idx").on(
            table.createdByUserId,
        ),
        acceptedByIdx: index("recording_tasks_accepted_by_user_id_idx").on(
            table.acceptedByUserId,
        ),
        statusChangedByIdx: index(
            "recording_tasks_status_changed_by_user_id_idx",
        ).on(table.statusChangedByUserId),
        updatedByIdx: index("recording_tasks_updated_by_user_id_idx").on(
            table.updatedByUserId,
        ),
        statusCheck: check(
            "recording_tasks_status_check",
            sql`${table.status} in ('proposed', 'open', 'done', 'dropped')`,
        ),
        sourceCheck: check(
            "recording_tasks_source_check",
            sql`${table.source} in ('riffado', 'plaud', 'manual')`,
        ),
        evidenceCheck: check(
            "recording_tasks_evidence_check",
            sql`(${table.evidenceSegmentIndex} is null and ${table.evidenceCharStart} is null and ${table.evidenceCharEnd} is null) or (${table.evidenceStartMs} is null and ${table.evidenceSegmentIndex} >= 0 and ${table.evidenceCharStart} >= 0 and ${table.evidenceCharStart} < ${table.evidenceCharEnd})`,
        ),
    }),
);

// A task proposal somebody said no to, so the next summary of the recording
// does not propose it again. A keyed HMAC, nothing readable.
export const recordingTaskRejections = pgTable(
    "recording_task_rejections",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        // The recording's owner.
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        itemId: text("recording_id")
            .notNull()
            .references(() => chatterItems.id, { onDelete: "cascade" }),
        fingerprintHmac: varchar("fingerprint_hmac", { length: 64 }).notNull(),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        unique: unique("recording_task_rejections_unique").on(
            table.itemId,
            table.fingerprintHmac,
        ),
        userIdIdx: index("recording_task_rejections_user_id_idx").on(
            table.userId,
        ),
    }),
);

// What a later recording's summary heard about an open task: it was done,
// or its deadline moved. Reviewed with that recording's task proposals.
export const taskUpdateProposals = pgTable(
    "task_update_proposals",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        taskId: text("task_id")
            .notNull()
            .references(() => recordingTasks.id, { onDelete: "cascade" }),
        // Where it was heard, and that recording's owner.
        itemId: text("recording_id")
            .notNull()
            .references(() => chatterItems.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        kind: varchar("kind", { length: 8 }).$type<"done" | "due">().notNull(),
        dueDate: date("due_date", { mode: "string" }),
        // Encrypted, as on `recording_tasks`.
        duePhrase: text("due_phrase"),
        quote: text("quote"),
        evidenceStartMs: integer("evidence_start_ms"),
        evidenceSegmentIndex: integer("evidence_segment_index"),
        evidenceCharStart: integer("evidence_char_start"),
        evidenceCharEnd: integer("evidence_char_end"),
        ticked: boolean("ticked").notNull().default(false),
        version: integer("version").notNull().default(0),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        unique: unique("task_update_proposals_unique").on(
            table.taskId,
            table.itemId,
            table.kind,
        ),
        recordingIdx: index("task_update_proposals_recording_id_idx").on(
            table.itemId,
        ),
        userIdIdx: index("task_update_proposals_user_id_idx").on(table.userId),
        kindCheck: check(
            "task_update_proposals_kind_check",
            sql`${table.kind} in ('done', 'due')`,
        ),
        dueCheck: check(
            "task_update_proposals_due_check",
            sql`${table.kind} = 'done' or ${table.dueDate} is not null`,
        ),
        evidenceCheck: check(
            "task_update_proposals_evidence_check",
            sql`(${table.evidenceSegmentIndex} is null and ${table.evidenceCharStart} is null and ${table.evidenceCharEnd} is null) or (${table.evidenceStartMs} is null and ${table.evidenceSegmentIndex} >= 0 and ${table.evidenceCharStart} >= 0 and ${table.evidenceCharStart} < ${table.evidenceCharEnd})`,
        ),
    }),
);

export const aiUsageEvents = pgTable(
    "ai_usage_events",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        itemId: text("recording_id")
            .notNull()
            .references(() => chatterItems.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        payerUserId: text("payer_user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        operation: varchar("operation", { length: 24 }).notNull(),
        provider: varchar("provider", { length: 100 }).notNull(),
        model: varchar("model", { length: 100 }).notNull(),
        inputTokens: integer("input_tokens"),
        outputTokens: integer("output_tokens"),
        audioSeconds: numeric("audio_seconds", { precision: 16, scale: 3 }),
        costUsd: numeric("cost_usd", { precision: 18, scale: 9 }),
        priceSource: varchar("price_source", { length: 32 }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        recordingPayerIdx: index("ai_usage_events_recording_payer_idx").on(
            table.itemId,
            table.payerUserId,
        ),
        userIdx: index("ai_usage_events_user_id_idx").on(table.userId),
        payerIdx: index("ai_usage_events_payer_user_id_idx").on(
            table.payerUserId,
        ),
    }),
);

// API Credentials (encrypted)
export const apiCredentials = pgTable(
    "api_credentials",
    {
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
        // The provider Learn runs on, where it should differ from the
        // enhancement default (a stronger model for learning, say). None
        // marked: Learn uses the enhancement default.
        isDefaultLearn: boolean("is_default_learn").notNull().default(false),
        // The user's price for this card's model, overriding Riffado's
        // published catalog. Both token rates or neither; null throughout
        // leaves the catalog price, or an unknown cost.
        inputUsdPerMillion: numeric("input_usd_per_million", {
            precision: 16,
            scale: 6,
        }),
        outputUsdPerMillion: numeric("output_usd_per_million", {
            precision: 16,
            scale: 6,
        }),
        audioUsdPerHour: numeric("audio_usd_per_hour", {
            precision: 16,
            scale: 6,
        }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        userIdIdx: index("api_credentials_user_id_idx").on(table.userId),
        // One provider for Learn per user at most.
        oneLearnDefault: uniqueIndex("api_credentials_one_learn_default")
            .on(table.userId)
            .where(sql`${table.isDefaultLearn}`),
    }),
);

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
    // Which kinds the Chatter pile shows: everything, recordings or mail.
    chatterKindFilter: varchar("chatter_kind_filter", { length: 8 })
        .$type<"all" | "audio" | "mail">()
        .notNull()
        .default("all"),
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
    // Legacy shared retention policy. Kept as deploy-surface compatibility;
    // new writes use the independent nullable day fields below.
    autoDeleteRecordings: boolean("auto_delete_recordings")
        .notNull()
        .default(false),
    retentionDays: integer("retention_days"), // nullable, range: 1-365
    // Which kinds of data the retention sweep removes once a recording is
    // older than `retentionDays`. Independent on purpose: keeping only the
    // summary and dropping the audio and transcript is a legitimate policy,
    // as is keeping the text and reclaiming the (much larger) audio.
    //
    // Legacy kinds default false so older dormant policies cannot begin
    // deleting data when the retention worker starts.
    retentionDeleteAudio: boolean("retention_delete_audio")
        .notNull()
        .default(false),
    retentionDeleteTranscript: boolean("retention_delete_transcript")
        .notNull()
        .default(false),
    retentionDeleteSummary: boolean("retention_delete_summary")
        .notNull()
        .default(false),
    // Null means unlimited retention. Existing shared policies are translated
    // at read time until the user saves the independent policy once.
    retentionRemoteOriginalDays: integer("retention_remote_original_days"),
    retentionLocalAudioDays: integer("retention_local_audio_days"),
    retentionLocalTranscriptDays: integer("retention_local_transcript_days"),
    retentionLocalSummaryDays: integer("retention_local_summary_days"),
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
    titleGenerationPrompt: jsonb("title_generation_prompt"), // TemplateConfiguration, see lib/ai/prompt-templates.ts
    // Summary prompt configuration
    summaryPrompt: jsonb("summary_prompt"), // TemplateConfiguration, see lib/ai/prompt-templates.ts
    // Topic detection: queued after a transcript with timings is written.
    autoDetectTopics: boolean("auto_detect_topics").notNull().default(false),
    // Automatic Learn after a transcript with timings (offered wherever
    // Learn runs); the title, summary and topics wait for its review.
    autoLearn: boolean("auto_learn").notNull().default(false),
    // After a Learn run finished, the Learn model reads the whole transcript
    // again with the Almanac and corrects misheard words.
    correctAfterLearn: boolean("correct_after_learn").notNull().default(true),
    // When the user last opened their task list: tasks assigned to them
    // since then count in its badge.
    tasksSeenAt: timestamp("tasks_seen_at"),
    // Summaries, tasks and Learn run on mail by themselves (paid by the
    // owner); off, mail waits for a person to ask.
    mailAutoProcess: boolean("mail_auto_process").notNull().default(true),
    topicPrompt: jsonb("topic_prompt"), // TemplateConfiguration, see lib/ai/prompt-templates.ts
    // AI output language (applies to summaries, AI-generated titles and topics).
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
        // The delivery claim: due rows that still have to go out.
        dueIdx: index("webhook_deliveries_due_idx")
            .on(table.nextAttemptAt, table.id)
            .where(sql`${table.status} in ('pending', 'processing')`),
        // The prune of settled deliveries.
        settledIdx: index("webhook_deliveries_settled_idx")
            .on(table.updatedAt)
            .where(sql`${table.status} in ('success', 'dead')`),
        userIdIdx: index("webhook_deliveries_user_id_idx").on(table.userId),
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
        // The stale-key sweep reads only rows that still list keys.
        staleKeysIdx: index("export_jobs_stale_storage_keys_idx")
            .on(table.createdAt, table.id)
            .where(sql`${table.staleStorageKeys} <> '[]'::jsonb`),
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

// One row per call to the external MCP server (`/api/mcp`): who called,
// through which client, what it touched and how it ended. Never arguments
// or content. Pruned after MCP_AUDIT_RETENTION_DAYS.
export const mcpAccessLog = pgTable(
    "mcp_access_log",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        at: timestamp("at").notNull().defaultNow(),
        // Null when the token resolved to no caller.
        callerKind: varchar("caller_kind", { length: 8 }).$type<
            "user" | "service"
        >(),
        // The Riffado user a user caller is; set null so the trail outlives
        // the account.
        userId: text("user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        // The token's `sub` and `azp` (else `client_id`).
        subject: text("subject"),
        clientId: text("client_id"),
        // Null for a request refused before any tool ran.
        tool: varchar("tool", { length: 64 }),
        outcome: varchar("outcome", { length: 16 })
            .$type<
                "ok" | "denied" | "conflict" | "error" | "not_found" | "invalid"
            >()
            .notNull(),
        // Ids of the recordings, tasks or records the call read or changed.
        targetIds: jsonb("target_ids")
            .$type<string[]>()
            .notNull()
            .default(sql`'[]'::jsonb`),
        ip: text("ip"),
    },
    (table) => ({
        atIdx: index("mcp_access_log_at_idx").on(table.at),
        userAtIdx: index("mcp_access_log_user_at_idx").on(
            table.userId,
            table.at,
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
        subscriberIdIdx: index("email_deliveries_subscriber_id_idx")
            .on(table.subscriberId)
            .where(sql`${table.subscriberId} is not null`),
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
        locale: varchar("locale", { length: 10 }).notNull().default("en"),
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
        dueScanIdx: index("stripe_webhook_events_due_idx")
            .on(table.nextAttemptAt, table.createdAt)
            .where(sql`${table.status} in ('pending', 'processing')`),
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
        // The claim scan, one kind at a time: due rows, best priority
        // first, oldest first within a priority.
        claimIdx: index("async_jobs_claim_idx")
            .on(
                table.kind,
                table.priority.desc().nullsFirst(),
                table.nextAttemptAt,
                table.createdAt,
            )
            .where(sql`${table.status} = 'pending'`),
        // The stale-claim reclaim reads only running rows.
        processingIdx: index("async_jobs_processing_idx")
            .on(table.heartbeatAt)
            .where(sql`${table.status} = 'processing'`),
        userIdIdx: index("async_jobs_user_id_idx").on(table.userId),
        // "Is there a job running for this recording?" -- the reattach query.
        subjectIdx: index("async_jobs_kind_subject_idx").on(
            table.kind,
            table.subjectId,
        ),
        // Prune scan over finished rows.
        completedAtIdx: index("async_jobs_completed_at_idx")
            .on(table.completedAt)
            .where(sql`${table.completedAt} is not null`),
        // Live jobs of a subject, whatever their kind.
        activeSubjectIdx: index("async_jobs_active_subject_idx")
            .on(table.subjectId)
            .where(sql`${table.status} in ('pending', 'processing')`),
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

// Inbound mail (Klepna). Addresses are virtual pipes into a pile or a folder;
// nothing lives "in a mailbox". Everything about a message is encrypted but
// the keyed hashes lookups run on.

// A local part on MAIL_DOMAIN and where it files mail. Never deleted, so a
// name once given out never comes back: a removed folder or account blocks
// its addresses, and no foreign key here cascades.
export const mailAddresses = pgTable(
    "mail_addresses",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        // `localPartHash(localPart)`: the whole lowercase local part under
        // MAIL_ADDRESS_HASH_SECRET, version `hashKeyVersion`.
        localPartHash: varchar("local_part_hash", { length: 64 }).notNull(),
        hashKeyVersion: integer("hash_key_version").notNull().default(1),
        // Encrypted.
        localPart: text("local_part").notNull(),
        kind: varchar("kind", { length: 16 })
            .$type<"mailbox" | "folder" | "secret">()
            .notNull(),
        // Whose namespace it is in: a user's, or the organization account's
        // for an Organization folder. Null once that account is gone.
        namespaceUserId: text("namespace_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        // A folder address's folder; null once the folder is gone.
        folderId: text("folder_id").references(() => recordingFolders.id, {
            onDelete: "set null",
        }),
        // A secret address files like the address it extends.
        baseAddressId: text("base_address_id").references(
            (): AnyPgColumn => mailAddresses.id,
            { onDelete: "set null" },
        ),
        createdByUserId: text("created_by_user_id").references(() => users.id, {
            onDelete: "set null",
        }),
        // Encrypted: what the owner calls a secret address.
        label: text("label"),
        status: varchar("status", { length: 16 })
            .$type<"active" | "paused" | "blocked">()
            .notNull()
            .default("active"),
        // A folder's current address; an edited one stays as secondary.
        primary: boolean("primary").notNull().default(true),
        blockedAt: timestamp("blocked_at"),
        lastReceivedAt: timestamp("last_received_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        // Blocked rows count: a name is given out once.
        hashUnique: unique("mail_addresses_local_part_hash_unique").on(
            table.localPartHash,
        ),
        oneMailbox: uniqueIndex("mail_addresses_one_mailbox")
            .on(table.namespaceUserId)
            .where(
                sql`${table.kind} = 'mailbox' and ${table.status} <> 'blocked'`,
            ),
        onePrimaryFolderAddress: uniqueIndex(
            "mail_addresses_one_primary_folder_address",
        )
            .on(table.folderId)
            .where(
                sql`${table.kind} = 'folder' and ${table.primary} and ${table.status} <> 'blocked'`,
            ),
        namespaceIdx: index("mail_addresses_namespace_user_id_idx").on(
            table.namespaceUserId,
        ),
        folderIdx: index("mail_addresses_folder_id_idx").on(table.folderId),
        baseIdx: index("mail_addresses_base_address_id_idx").on(
            table.baseAddressId,
        ),
        createdByIdx: index("mail_addresses_created_by_user_id_idx").on(
            table.createdByUserId,
        ),
        kindCheck: check(
            "mail_addresses_kind_check",
            sql`${table.kind} in ('mailbox', 'folder', 'secret')`,
        ),
        statusCheck: check(
            "mail_addresses_status_check",
            sql`${table.status} in ('active', 'paused', 'blocked')`,
        ),
        // Only a blocked address may lose what it files into: deleting a
        // folder or an account blocks its addresses first.
        liveCheck: check(
            "mail_addresses_live_check",
            sql`${table.status} = 'blocked' or (${table.namespaceUserId} is not null and (${table.kind} <> 'folder' or ${table.folderId} is not null) and (${table.kind} <> 'secret' or ${table.baseAddressId} is not null))`,
        ),
    }),
);

// A mail message: the `mail` kind of a Chatter item, sharing its id.
export const mailMessages = pgTable(
    "mail_messages",
    {
        id: text("id").primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        kind: varchar("kind", { length: 16 })
            .$type<"mail">()
            .notNull()
            .default("mail"),
        // The address it came through (the first that accepted it).
        addressId: text("address_id").references(() => mailAddresses.id, {
            onDelete: "set null",
        }),
        // Keyed hash of the raw message: one item per owner and message,
        // whatever retries and recipients brought it again.
        rawHash: varchar("raw_hash", { length: 64 }).notNull(),
        // Keyed hashes of `Message-ID` and of the thread's root.
        messageIdHash: varchar("message_id_hash", { length: 64 }),
        threadKeyHash: varchar("thread_key_hash", { length: 64 }),
        // The `Date` header, as claimed.
        sentAt: timestamp("sent_at"),
        receivedAt: timestamp("received_at").notNull(),
        sizeBytes: integer("size_bytes").notNull(),
        // The encrypted raw message; null once retention removed it.
        rawStoragePath: text("raw_storage_path"),
        // Encrypted: DKIM signatures and results, SPF, ARC (`MailAuth`).
        auth: jsonb("auth").notNull(),
        // A passing DKIM signature of the From domain vouches for the sender.
        senderVerified: boolean("sender_verified").notNull(),
        // Machine-sent (auto-replies, lists, DSNs): stored, no AI.
        autoGenerated: boolean("auto_generated").notNull().default(false),
        // Nothing readable (TNEF, S/MIME, PGP): stored, no AI.
        unreadable: boolean("unreadable").notNull().default(false),
        // Encrypted: the attachments' names, types and sizes.
        attachments: jsonb("attachments"),
        rawReapedAt: timestamp("raw_reaped_at"),
        deletedAt: timestamp("deleted_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        itemUserFk: foreignKey({
            name: "mail_messages_item_user_fk",
            columns: [table.id, table.userId],
            foreignColumns: [chatterItems.id, chatterItems.userId],
        }).onDelete("cascade"),
        itemKindFk: foreignKey({
            name: "mail_messages_item_kind_fk",
            columns: [table.id, table.kind],
            foreignColumns: [chatterItems.id, chatterItems.kind],
        }).onDelete("cascade"),
        kindCheck: check(
            "mail_messages_kind_check",
            sql`${table.kind} = 'mail'`,
        ),
        ownerRawUnique: unique("mail_messages_user_id_raw_hash_unique").on(
            table.userId,
            table.rawHash,
        ),
        messageIdIdx: index("mail_messages_user_id_message_id_hash_idx").on(
            table.userId,
            table.messageIdHash,
        ),
        threadIdx: index("mail_messages_user_id_thread_key_hash_idx").on(
            table.userId,
            table.threadKeyHash,
        ),
        addressIdx: index("mail_messages_address_id_idx").on(table.addressId),
    }),
);

// Who a mail is from and to, and who a quoted part claims to be by, under
// an opaque reference (`p1`, `p2`) that prompts and stored rows carry.
export const mailParticipants = pgTable(
    "mail_participants",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        itemId: text("item_id")
            .notNull()
            .references(() => mailMessages.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        ref: varchar("ref", { length: 8 }).notNull(),
        // `ParticipantRole`s.
        roles: jsonb("roles").$type<string[]>().notNull(),
        // `addressHash(address)`, to find a person's mail by address.
        addressHash: varchar("address_hash", { length: 64 }),
        // Encrypted.
        address: text("address"),
        name: text("name"),
        personId: text("person_id").references(() => people.id, {
            onDelete: "set null",
        }),
        // The address was proven by the sender's DKIM signature.
        authenticated: boolean("authenticated").notNull().default(false),
        position: integer("position").notNull().default(0),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        itemRefUnique: unique("mail_participants_item_id_ref_unique").on(
            table.itemId,
            table.ref,
        ),
        userAddressIdx: index("mail_participants_user_id_address_hash_idx").on(
            table.userId,
            table.addressHash,
        ),
        personIdx: index("mail_participants_person_id_idx").on(table.personId),
    }),
);

// A mail's parsed content: its segments (body, signature, quoted parts),
// as `ItemContent` reads them. Re-parsing writes a new revision.
export const mailContents = pgTable(
    "mail_contents",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        itemId: text("item_id")
            .notNull()
            .references(() => mailMessages.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        revision: integer("revision").notNull().default(0),
        parserVersion: integer("parser_version").notNull(),
        // Encrypted `ContentSegment[]`.
        segments: jsonb("segments").notNull(),
        language: varchar("language", { length: 10 }),
        // `llmInputFingerprint` of what a model reads of it.
        fingerprint: varchar("fingerprint", { length: 64 }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => ({
        itemUnique: unique("mail_contents_item_id_unique").on(table.itemId),
        userIdIdx: index("mail_contents_user_id_idx").on(table.userId),
    }),
);

// What happened to mail sent to someone's addresses, for them to see:
// accepted, or refused and why. No addresses or subjects; pruned.
export const mailDeliveryLog = pgTable(
    "mail_delivery_log",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => nanoid()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        at: timestamp("at").notNull().defaultNow(),
        addressId: text("address_id").references(() => mailAddresses.id, {
            onDelete: "set null",
        }),
        // Encrypted: the From domain.
        senderDomain: text("sender_domain"),
        outcome: varchar("outcome", { length: 16 })
            .$type<"accepted" | "refused" | "duplicate">()
            .notNull(),
        reason: varchar("reason", { length: 32 }),
        itemId: text("item_id").references(() => chatterItems.id, {
            onDelete: "set null",
        }),
    },
    (table) => ({
        userAtIdx: index("mail_delivery_log_user_id_at_idx").on(
            table.userId,
            table.at,
        ),
        atIdx: index("mail_delivery_log_at_idx").on(table.at),
    }),
);

// A mail sent to an Organization address waits in its sender's pile until
// they share it into that folder through the share gate (D2).
export const mailPendingShares = pgTable(
    "mail_pending_shares",
    {
        itemId: text("item_id")
            .notNull()
            .references(() => chatterItems.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        folderId: text("folder_id")
            .notNull()
            .references(() => recordingFolders.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.itemId, table.folderId] }),
        userIdIdx: index("mail_pending_shares_user_id_idx").on(table.userId),
        folderIdIdx: index("mail_pending_shares_folder_id_idx").on(
            table.folderId,
        ),
    }),
);
