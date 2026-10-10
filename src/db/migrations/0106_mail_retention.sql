ALTER TABLE "user_settings" ADD COLUMN "retention_mail_raw_days" integer;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "retention_mail_content_days" integer;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "retention_mail_summary_days" integer;