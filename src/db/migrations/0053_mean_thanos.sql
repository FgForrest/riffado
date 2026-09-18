ALTER TABLE "newsletter_subscriptions" ADD COLUMN "locale" varchar(10) DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ui_locale" varchar(10);