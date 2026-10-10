CREATE TABLE "chatter_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" varchar(16) NOT NULL,
	"title" text NOT NULL,
	"title_edited_at" timestamp,
	"occurred_at" timestamp NOT NULL,
	"deleted_at" timestamp,
	"summary_due_at" timestamp,
	"content_reaped_at" timestamp,
	"summary_reaped_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chatter_items_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "chatter_items_id_kind_unique" UNIQUE("id","kind"),
	CONSTRAINT "chatter_items_kind_check" CHECK ("chatter_items"."kind" in ('audio', 'mail'))
);
--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "kind" varchar(16) DEFAULT 'audio' NOT NULL;--> statement-breakpoint
ALTER TABLE "chatter_items" ADD CONSTRAINT "chatter_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chatter_items_user_id_occurred_at_live_idx" ON "chatter_items" USING btree ("user_id","occurred_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "chatter_items"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "chatter_items_summary_due_at_idx" ON "chatter_items" USING btree ("summary_due_at") WHERE "chatter_items"."summary_due_at" is not null;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_kind_check" CHECK ("recordings"."kind" = 'audio');