ALTER TABLE "transcriptions" ADD COLUMN "topics" jsonb;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "auto_detect_topics" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "topic_prompt" jsonb;