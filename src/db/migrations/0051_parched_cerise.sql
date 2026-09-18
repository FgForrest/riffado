CREATE TABLE "filesystem_export_settings" (
	"export_configuration_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"target_path" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder_export_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"provider" varchar(32) NOT NULL,
	"export_audio" boolean DEFAULT true NOT NULL,
	"export_transcript" boolean DEFAULT true NOT NULL,
	"export_summary" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder_export_materializations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"export_configuration_id" text NOT NULL,
	"recording_id" text NOT NULL,
	"placement_folder_id" text NOT NULL,
	"artifact_type" varchar(16) NOT NULL,
	"artifact_id" text NOT NULL,
	"artifact_version" varchar(64) NOT NULL,
	"logical_path" text NOT NULL,
	"expected_size" bigint NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"exported_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "folder_export_materializations_placement_unique" UNIQUE("export_configuration_id","placement_folder_id","artifact_type","artifact_id")
);
--> statement-breakpoint
ALTER TABLE "filesystem_export_settings" ADD CONSTRAINT "filesystem_export_settings_export_configuration_id_folder_export_configurations_id_fk" FOREIGN KEY ("export_configuration_id") REFERENCES "public"."folder_export_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filesystem_export_settings" ADD CONSTRAINT "filesystem_export_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_configurations" ADD CONSTRAINT "folder_export_configurations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_configurations" ADD CONSTRAINT "folder_export_configurations_folder_id_recording_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."recording_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_materializations" ADD CONSTRAINT "folder_export_materializations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_materializations" ADD CONSTRAINT "folder_export_materializations_export_configuration_id_folder_export_configurations_id_fk" FOREIGN KEY ("export_configuration_id") REFERENCES "public"."folder_export_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_materializations" ADD CONSTRAINT "folder_export_materializations_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_materializations" ADD CONSTRAINT "folder_export_materializations_placement_folder_id_recording_folders_id_fk" FOREIGN KEY ("placement_folder_id") REFERENCES "public"."recording_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "filesystem_export_settings_user_id_idx" ON "filesystem_export_settings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "folder_export_configurations_user_id_idx" ON "folder_export_configurations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "folder_export_configurations_folder_id_idx" ON "folder_export_configurations" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "folder_export_materializations_user_id_idx" ON "folder_export_materializations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "folder_export_materializations_pending_idx" ON "folder_export_materializations" USING btree ("status","updated_at");