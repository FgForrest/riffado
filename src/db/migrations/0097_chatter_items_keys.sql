ALTER TABLE "ai_enhancements" DROP CONSTRAINT "ai_enhancements_recording_id_recordings_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_usage_events" DROP CONSTRAINT "ai_usage_events_recording_id_recordings_id_fk";
--> statement-breakpoint
ALTER TABLE "folder_export_materializations" DROP CONSTRAINT "folder_export_materializations_recording_id_recordings_id_fk";
--> statement-breakpoint
ALTER TABLE "folder_export_placements" DROP CONSTRAINT "folder_export_placements_recording_id_recordings_id_fk";
--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" DROP CONSTRAINT "knowledge_fact_evidence_recording_id_recordings_id_fk";
--> statement-breakpoint
ALTER TABLE "learn_dismissals" DROP CONSTRAINT "learn_dismissals_recording_id_recordings_id_fk";
--> statement-breakpoint
ALTER TABLE "learn_runs" DROP CONSTRAINT "learn_runs_recording_id_recordings_id_fk";
--> statement-breakpoint
ALTER TABLE "recording_folder_assignments" DROP CONSTRAINT "recording_folder_assignments_recording_id_recordings_id_fk";
--> statement-breakpoint
ALTER TABLE "recording_task_rejections" DROP CONSTRAINT "recording_task_rejections_recording_id_recordings_id_fk";
--> statement-breakpoint
ALTER TABLE "recording_tasks" DROP CONSTRAINT "recording_tasks_recording_id_recordings_id_fk";
--> statement-breakpoint
ALTER TABLE "task_update_proposals" DROP CONSTRAINT "task_update_proposals_recording_id_recordings_id_fk";
--> statement-breakpoint
DROP INDEX "recordings_summary_due_at_idx";--> statement-breakpoint
ALTER TABLE "recordings" ALTER COLUMN "filename" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recordings" ALTER COLUMN "start_time" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD CONSTRAINT "ai_enhancements_recording_id_chatter_items_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_recording_id_chatter_items_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_materializations" ADD CONSTRAINT "folder_export_materializations_recording_id_chatter_items_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_export_placements" ADD CONSTRAINT "folder_export_placements_recording_id_chatter_items_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" ADD CONSTRAINT "knowledge_fact_evidence_recording_id_chatter_items_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn_dismissals" ADD CONSTRAINT "learn_dismissals_recording_id_chatter_items_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn_runs" ADD CONSTRAINT "learn_runs_recording_id_chatter_items_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_folder_assignments" ADD CONSTRAINT "recording_folder_assignments_recording_id_chatter_items_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_task_rejections" ADD CONSTRAINT "recording_task_rejections_recording_id_chatter_items_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD CONSTRAINT "recording_tasks_recording_id_chatter_items_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_item_user_fk" FOREIGN KEY ("id","user_id") REFERENCES "public"."chatter_items"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_item_kind_fk" FOREIGN KEY ("id","kind") REFERENCES "public"."chatter_items"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD CONSTRAINT "task_update_proposals_recording_id_chatter_items_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;