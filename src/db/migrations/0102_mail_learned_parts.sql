CREATE TABLE "mail_learned_parts" (
	"user_id" text NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"item_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail_learned_parts_user_id_fingerprint_pk" PRIMARY KEY("user_id","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "mail_learned_parts" ADD CONSTRAINT "mail_learned_parts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_learned_parts" ADD CONSTRAINT "mail_learned_parts_item_id_chatter_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_learned_parts_item_id_idx" ON "mail_learned_parts" USING btree ("item_id");