CREATE TABLE "recording_folder_assignments" (
	"user_id" text NOT NULL,
	"recording_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recording_folder_assignments_recording_id_folder_id_pk" PRIMARY KEY("recording_id","folder_id")
);
--> statement-breakpoint
CREATE TABLE "recording_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"name_hash" varchar(64) NOT NULL,
	"kind" varchar(16) DEFAULT 'custom' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recording_folder_assignments" ADD CONSTRAINT "recording_folder_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_folder_assignments" ADD CONSTRAINT "recording_folder_assignments_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_folder_assignments" ADD CONSTRAINT "recording_folder_assignments_folder_id_recording_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."recording_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_folders" ADD CONSTRAINT "recording_folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_folders" ADD CONSTRAINT "recording_folders_parent_id_recording_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."recording_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recording_folder_assignments_user_id_idx" ON "recording_folder_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recording_folder_assignments_folder_id_idx" ON "recording_folder_assignments" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "recording_folders_user_id_idx" ON "recording_folders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recording_folders_parent_id_idx" ON "recording_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_folders_user_parent_name_unique" ON "recording_folders" USING btree ("user_id","parent_id","name_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_folders_user_root_kind_unique" ON "recording_folders" USING btree ("user_id","kind") WHERE "recording_folders"."kind" in ('private', 'public');