ALTER TABLE "recordings" ADD COLUMN "audio_reaped_at" timestamp;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "transcript_reaped_at" timestamp;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "summary_reaped_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "retention_delete_audio" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "retention_delete_transcript" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "retention_delete_summary" boolean DEFAULT false NOT NULL;