ALTER TABLE "ai_enhancements" DROP CONSTRAINT "ai_enhancements_transcription_id_transcriptions_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD CONSTRAINT "ai_enhancements_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE set null ON UPDATE no action;