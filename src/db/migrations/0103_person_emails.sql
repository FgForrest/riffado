CREATE TABLE "person_emails" (
	"user_id" text NOT NULL,
	"person_id" text NOT NULL,
	"email_hash" varchar(64) NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "person_emails_user_id_email_hash_pk" PRIMARY KEY("user_id","email_hash")
);
--> statement-breakpoint
ALTER TABLE "person_emails" ADD CONSTRAINT "person_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_emails" ADD CONSTRAINT "person_emails_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_emails_person_id_idx" ON "person_emails" USING btree ("person_id");