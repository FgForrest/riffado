ALTER TABLE "knowledge_fact_evidence" ADD COLUMN "provenance" varchar(16);--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD COLUMN "evidence_provenance" varchar(16);