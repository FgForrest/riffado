CREATE TABLE "drive_export_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"export_configuration_id" text NOT NULL,
	"logical_path" text NOT NULL,
	"drive_file_id" text NOT NULL,
	"kind" varchar(16) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "drive_export_nodes_path_unique" UNIQUE("export_configuration_id","logical_path")
);
--> statement-breakpoint
CREATE TABLE "google_drive_export_settings" (
	"export_configuration_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_subject" text NOT NULL,
	"root_folder_id" text NOT NULL,
	"root_folder_name" text NOT NULL,
	"drive_id" text,
	"transcript_format" varchar(16) DEFAULT 'markdown' NOT NULL,
	"summary_format" varchar(16) DEFAULT 'markdown' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" varchar(32) NOT NULL,
	"subject" text NOT NULL,
	"email" text NOT NULL,
	"hosted_domain" text,
	"refresh_token" text NOT NULL,
	"scopes" text NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_connections_user_provider_unique" UNIQUE("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "folder_export_materializations" DROP CONSTRAINT "folder_export_materializations_placement_unique";--> statement-breakpoint
ALTER TABLE "folder_export_configurations" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "folder_export_configurations" ADD COLUMN "last_error_at" timestamp;--> statement-breakpoint
ALTER TABLE "folder_export_materializations" ADD COLUMN "format" varchar(16) DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_export_nodes" ADD CONSTRAINT "drive_export_nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_export_nodes" ADD CONSTRAINT "drive_export_nodes_export_configuration_id_folder_export_configurations_id_fk" FOREIGN KEY ("export_configuration_id") REFERENCES "public"."folder_export_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_drive_export_settings" ADD CONSTRAINT "google_drive_export_settings_export_configuration_id_folder_export_configurations_id_fk" FOREIGN KEY ("export_configuration_id") REFERENCES "public"."folder_export_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_drive_export_settings" ADD CONSTRAINT "google_drive_export_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_export_nodes_user_id_idx" ON "drive_export_nodes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "google_drive_export_settings_user_id_idx" ON "google_drive_export_settings" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "folder_export_materializations" ADD CONSTRAINT "folder_export_materializations_placement_unique" UNIQUE("export_configuration_id","placement_folder_id","artifact_type","artifact_id","format");