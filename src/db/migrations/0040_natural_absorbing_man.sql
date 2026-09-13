ALTER TABLE "user_settings" ADD COLUMN "summary_multi_pass" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "summary_multi_pass_rounds" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "summary_multi_pass_auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "summary_merge_prompt" text;