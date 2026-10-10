ALTER TABLE "knowledge_facts" DROP CONSTRAINT "knowledge_facts_origin_check";--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" ALTER COLUMN "transcription_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" ALTER COLUMN "start_ms" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" ALTER COLUMN "end_ms" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "learn_runs" ALTER COLUMN "transcription_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" ADD COLUMN "segment_index" integer;--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" ADD COLUMN "char_start" integer;--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" ADD COLUMN "char_end" integer;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD COLUMN "evidence_segment_index" integer;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD COLUMN "evidence_char_start" integer;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD COLUMN "evidence_char_end" integer;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD COLUMN "evidence_provenance" varchar(16);--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD COLUMN "evidence_segment_index" integer;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD COLUMN "evidence_char_start" integer;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD COLUMN "evidence_char_end" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_fact_evidence_text_unique" ON "knowledge_fact_evidence" USING btree ("fact_id","recording_id","segment_index","char_start","char_end") WHERE "knowledge_fact_evidence"."segment_index" is not null;--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" ADD CONSTRAINT "knowledge_fact_evidence_anchor_check" CHECK (("knowledge_fact_evidence"."transcription_id" is not null and "knowledge_fact_evidence"."start_ms" is not null and "knowledge_fact_evidence"."end_ms" is not null and "knowledge_fact_evidence"."segment_index" is null and "knowledge_fact_evidence"."char_start" is null and "knowledge_fact_evidence"."char_end" is null) or ("knowledge_fact_evidence"."start_ms" is null and "knowledge_fact_evidence"."end_ms" is null and "knowledge_fact_evidence"."segment_index" >= 0 and "knowledge_fact_evidence"."char_start" >= 0 and "knowledge_fact_evidence"."char_start" < "knowledge_fact_evidence"."char_end"));--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_origin_check" CHECK ("knowledge_facts"."origin" in ('recording', 'mail', 'manual'));--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD CONSTRAINT "recording_tasks_evidence_check" CHECK (("recording_tasks"."evidence_segment_index" is null and "recording_tasks"."evidence_char_start" is null and "recording_tasks"."evidence_char_end" is null) or ("recording_tasks"."evidence_start_ms" is null and "recording_tasks"."evidence_segment_index" >= 0 and "recording_tasks"."evidence_char_start" >= 0 and "recording_tasks"."evidence_char_start" < "recording_tasks"."evidence_char_end"));--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD CONSTRAINT "task_update_proposals_evidence_check" CHECK (("task_update_proposals"."evidence_segment_index" is null and "task_update_proposals"."evidence_char_start" is null and "task_update_proposals"."evidence_char_end" is null) or ("task_update_proposals"."evidence_start_ms" is null and "task_update_proposals"."evidence_segment_index" >= 0 and "task_update_proposals"."evidence_char_start" >= 0 and "task_update_proposals"."evidence_char_start" < "task_update_proposals"."evidence_char_end"));