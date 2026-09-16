ALTER TABLE "ai_enhancements" DROP CONSTRAINT "ai_enhancements_recording_id_user_id_unique";--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD COLUMN "transcription_id" text;--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD CONSTRAINT "ai_enhancements_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_enhancements_transcription_id_idx" ON "ai_enhancements" USING btree ("transcription_id");--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD CONSTRAINT "ai_enhancements_recording_user_source_unique" UNIQUE("recording_id","user_id","source");