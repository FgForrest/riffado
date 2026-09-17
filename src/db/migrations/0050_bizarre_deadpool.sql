ALTER TABLE "recordings" ADD COLUMN "remote_retention_claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "retention_remote_original_days" integer;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "retention_local_audio_days" integer;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "retention_local_transcript_days" integer;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "retention_local_summary_days" integer;