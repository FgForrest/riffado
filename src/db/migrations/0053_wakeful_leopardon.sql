CREATE TABLE "folder_export_directories" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"export_configuration_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"target_path" text NOT NULL,
	"directory_name" text NOT NULL,
	"logical_path" text NOT NULL,
	"expected" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "folder_export_directories_folder_unique" UNIQUE("export_configuration_id","folder_id")
);
--> statement-breakpoint
CREATE TABLE "folder_export_placements" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"export_configuration_id" text NOT NULL,
	"recording_id" text NOT NULL,
	"placement_folder_id" text NOT NULL,
	"target_path" text NOT NULL,
	"directory_name" text NOT NULL,
	"logical_path" text NOT NULL,
	"expected" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "folder_export_placements_placement_unique" UNIQUE("export_configuration_id","recording_id","placement_folder_id")
);
--> statement-breakpoint
ALTER TABLE "folder_export_directories" ADD CONSTRAINT "folder_export_directories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_directories" ADD CONSTRAINT "folder_export_directories_export_configuration_id_folder_export_configurations_id_fk" FOREIGN KEY ("export_configuration_id") REFERENCES "public"."folder_export_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_directories" ADD CONSTRAINT "folder_export_directories_folder_id_recording_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."recording_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_placements" ADD CONSTRAINT "folder_export_placements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_placements" ADD CONSTRAINT "folder_export_placements_export_configuration_id_folder_export_configurations_id_fk" FOREIGN KEY ("export_configuration_id") REFERENCES "public"."folder_export_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_placements" ADD CONSTRAINT "folder_export_placements_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_placements" ADD CONSTRAINT "folder_export_placements_placement_folder_id_recording_folders_id_fk" FOREIGN KEY ("placement_folder_id") REFERENCES "public"."recording_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folder_export_directories_expected_path_unique" ON "folder_export_directories" USING btree ("export_configuration_id","logical_path") WHERE "folder_export_directories"."expected";--> statement-breakpoint
CREATE INDEX "folder_export_directories_user_id_idx" ON "folder_export_directories" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folder_export_placements_expected_path_unique" ON "folder_export_placements" USING btree ("export_configuration_id","logical_path") WHERE "folder_export_placements"."expected";--> statement-breakpoint
CREATE INDEX "folder_export_placements_user_id_idx" ON "folder_export_placements" USING btree ("user_id");