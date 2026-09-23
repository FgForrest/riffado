CREATE TABLE "person_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"user_id" text NOT NULL,
	"notes" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "person_notes_person_id_user_id_unique" UNIQUE("person_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD COLUMN "produced_by_user_id" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "recording_folders" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_folders" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "unshared_at" timestamp;--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN "produced_by_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" varchar(16) DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "person_notes" ADD CONSTRAINT "person_notes_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_notes" ADD CONSTRAINT "person_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_notes_user_id_idx" ON "person_notes" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD CONSTRAINT "ai_enhancements_produced_by_user_id_users_id_fk" FOREIGN KEY ("produced_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_folders" ADD CONSTRAINT "recording_folders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcriptions" ADD CONSTRAINT "transcriptions_produced_by_user_id_users_id_fk" FOREIGN KEY ("produced_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_single_org_account" ON "users" USING btree ("role") WHERE "users"."role" = 'org';