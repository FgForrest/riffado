CREATE TABLE "mail_addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"local_part_hash" varchar(64) NOT NULL,
	"hash_key_version" integer DEFAULT 1 NOT NULL,
	"local_part" text NOT NULL,
	"kind" varchar(16) NOT NULL,
	"namespace_user_id" text,
	"folder_id" text,
	"base_address_id" text,
	"created_by_user_id" text,
	"label" text,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"primary" boolean DEFAULT true NOT NULL,
	"blocked_at" timestamp,
	"last_received_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail_addresses_local_part_hash_unique" UNIQUE("local_part_hash"),
	CONSTRAINT "mail_addresses_kind_check" CHECK ("mail_addresses"."kind" in ('mailbox', 'folder', 'secret')),
	CONSTRAINT "mail_addresses_status_check" CHECK ("mail_addresses"."status" in ('active', 'paused', 'blocked')),
	CONSTRAINT "mail_addresses_live_check" CHECK ("mail_addresses"."status" = 'blocked' or ("mail_addresses"."namespace_user_id" is not null and ("mail_addresses"."kind" <> 'folder' or "mail_addresses"."folder_id" is not null) and ("mail_addresses"."kind" <> 'secret' or "mail_addresses"."base_address_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "mail_contents" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"user_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"parser_version" integer NOT NULL,
	"segments" jsonb NOT NULL,
	"language" varchar(10),
	"fingerprint" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail_contents_item_id_unique" UNIQUE("item_id")
);
--> statement-breakpoint
CREATE TABLE "mail_delivery_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	"address_id" text,
	"sender_domain" text,
	"outcome" varchar(16) NOT NULL,
	"reason" varchar(32),
	"item_id" text
);
--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" varchar(16) DEFAULT 'mail' NOT NULL,
	"address_id" text,
	"raw_hash" varchar(64) NOT NULL,
	"message_id_hash" varchar(64),
	"thread_key_hash" varchar(64),
	"sent_at" timestamp,
	"received_at" timestamp NOT NULL,
	"size_bytes" integer NOT NULL,
	"raw_storage_path" text,
	"auth" jsonb NOT NULL,
	"sender_verified" boolean NOT NULL,
	"auto_generated" boolean DEFAULT false NOT NULL,
	"unreadable" boolean DEFAULT false NOT NULL,
	"attachments" jsonb,
	"raw_reaped_at" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail_messages_user_id_raw_hash_unique" UNIQUE("user_id","raw_hash"),
	CONSTRAINT "mail_messages_kind_check" CHECK ("mail_messages"."kind" = 'mail')
);
--> statement-breakpoint
CREATE TABLE "mail_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"user_id" text NOT NULL,
	"ref" varchar(8) NOT NULL,
	"roles" jsonb NOT NULL,
	"address_hash" varchar(64),
	"address" text,
	"name" text,
	"person_id" text,
	"authenticated" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail_participants_item_id_ref_unique" UNIQUE("item_id","ref")
);
--> statement-breakpoint
CREATE TABLE "mail_pending_shares" (
	"item_id" text NOT NULL,
	"user_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail_pending_shares_item_id_folder_id_pk" PRIMARY KEY("item_id","folder_id")
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "mail_auto_process" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_sso_login_at" timestamp;--> statement-breakpoint
ALTER TABLE "mail_addresses" ADD CONSTRAINT "mail_addresses_namespace_user_id_users_id_fk" FOREIGN KEY ("namespace_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_addresses" ADD CONSTRAINT "mail_addresses_folder_id_recording_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."recording_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_addresses" ADD CONSTRAINT "mail_addresses_base_address_id_mail_addresses_id_fk" FOREIGN KEY ("base_address_id") REFERENCES "public"."mail_addresses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_addresses" ADD CONSTRAINT "mail_addresses_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_contents" ADD CONSTRAINT "mail_contents_item_id_mail_messages_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."mail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_contents" ADD CONSTRAINT "mail_contents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_delivery_log" ADD CONSTRAINT "mail_delivery_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_delivery_log" ADD CONSTRAINT "mail_delivery_log_address_id_mail_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."mail_addresses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_delivery_log" ADD CONSTRAINT "mail_delivery_log_item_id_chatter_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."chatter_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_address_id_mail_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."mail_addresses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_item_user_fk" FOREIGN KEY ("id","user_id") REFERENCES "public"."chatter_items"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_item_kind_fk" FOREIGN KEY ("id","kind") REFERENCES "public"."chatter_items"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_participants" ADD CONSTRAINT "mail_participants_item_id_mail_messages_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."mail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_participants" ADD CONSTRAINT "mail_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_participants" ADD CONSTRAINT "mail_participants_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_pending_shares" ADD CONSTRAINT "mail_pending_shares_item_id_chatter_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_pending_shares" ADD CONSTRAINT "mail_pending_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_pending_shares" ADD CONSTRAINT "mail_pending_shares_folder_id_recording_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."recording_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_addresses_one_mailbox" ON "mail_addresses" USING btree ("namespace_user_id") WHERE "mail_addresses"."kind" = 'mailbox' and "mail_addresses"."status" <> 'blocked';--> statement-breakpoint
CREATE UNIQUE INDEX "mail_addresses_one_primary_folder_address" ON "mail_addresses" USING btree ("folder_id") WHERE "mail_addresses"."kind" = 'folder' and "mail_addresses"."primary" and "mail_addresses"."status" <> 'blocked';--> statement-breakpoint
CREATE INDEX "mail_addresses_namespace_user_id_idx" ON "mail_addresses" USING btree ("namespace_user_id");--> statement-breakpoint
CREATE INDEX "mail_addresses_folder_id_idx" ON "mail_addresses" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "mail_addresses_base_address_id_idx" ON "mail_addresses" USING btree ("base_address_id");--> statement-breakpoint
CREATE INDEX "mail_addresses_created_by_user_id_idx" ON "mail_addresses" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "mail_contents_user_id_idx" ON "mail_contents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mail_delivery_log_user_id_at_idx" ON "mail_delivery_log" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "mail_delivery_log_at_idx" ON "mail_delivery_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "mail_messages_user_id_message_id_hash_idx" ON "mail_messages" USING btree ("user_id","message_id_hash");--> statement-breakpoint
CREATE INDEX "mail_messages_user_id_thread_key_hash_idx" ON "mail_messages" USING btree ("user_id","thread_key_hash");--> statement-breakpoint
CREATE INDEX "mail_messages_address_id_idx" ON "mail_messages" USING btree ("address_id");--> statement-breakpoint
CREATE INDEX "mail_participants_user_id_address_hash_idx" ON "mail_participants" USING btree ("user_id","address_hash");--> statement-breakpoint
CREATE INDEX "mail_participants_person_id_idx" ON "mail_participants" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "mail_pending_shares_user_id_idx" ON "mail_pending_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mail_pending_shares_folder_id_idx" ON "mail_pending_shares" USING btree ("folder_id");