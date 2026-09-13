CREATE TYPE "public"."async_job_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "async_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" varchar(64) NOT NULL,
	"subject_id" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "async_job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"claim_token" text,
	"progress" jsonb,
	"result" jsonb,
	"last_error" text,
	"error_code" varchar(64),
	"heartbeat_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "async_jobs" ADD CONSTRAINT "async_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "async_jobs_due_idx" ON "async_jobs" USING btree ("status","priority","next_attempt_at");--> statement-breakpoint
CREATE INDEX "async_jobs_user_id_idx" ON "async_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "async_jobs_kind_subject_idx" ON "async_jobs" USING btree ("kind","subject_id");--> statement-breakpoint
CREATE INDEX "async_jobs_completed_at_idx" ON "async_jobs" USING btree ("completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "async_jobs_active_unique" ON "async_jobs" USING btree ("kind","subject_id") WHERE "async_jobs"."status" in ('pending', 'processing');