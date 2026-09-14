CREATE TYPE "public"."fact_source" AS ENUM('user', 'calendar', 'meet', 'llm', 'heuristic');--> statement-breakpoint
CREATE TYPE "public"."fact_status" AS ENUM('confirmed', 'suggested', 'rejected');--> statement-breakpoint
CREATE TABLE "people" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"primary_email" text,
	"notes" text,
	"primary_email_hash" varchar(64),
	"merged_into_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "people_user_id_email_hash_unique" UNIQUE("user_id","primary_email_hash")
);
--> statement-breakpoint
CREATE TABLE "transcript_speakers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"transcription_id" text NOT NULL,
	"label" varchar(64) NOT NULL,
	"person_id" text,
	"source" "fact_source" NOT NULL,
	"status" "fact_status" DEFAULT 'suggested' NOT NULL,
	"confidence" real,
	"evidence_start_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_speakers_transcription_id_label_unique" UNIQUE("transcription_id","label")
);
--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_speakers" ADD CONSTRAINT "transcript_speakers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_speakers" ADD CONSTRAINT "transcript_speakers_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_speakers" ADD CONSTRAINT "transcript_speakers_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "people_user_id_idx" ON "people" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transcript_speakers_person_id_idx" ON "transcript_speakers" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "transcript_speakers_user_id_idx" ON "transcript_speakers" USING btree ("user_id");