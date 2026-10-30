ALTER TABLE "recipient_verifications" DROP CONSTRAINT "recipient_verifications_destination_id_recipient_destinations_id_fk";
--> statement-breakpoint
CREATE INDEX "recipient_verifications_destination_idx" ON "recipient_verifications" USING btree ("destination_id");