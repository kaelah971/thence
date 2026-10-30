ALTER TABLE "recipient_verifications" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "recipient_verifications" ADD COLUMN "destination_id" uuid;--> statement-breakpoint
ALTER TABLE "recipient_verifications" ADD COLUMN "initiated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "recipient_verifications" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recipient_verifications" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recipient_verifications" ADD CONSTRAINT "recipient_verifications_destination_id_recipient_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."recipient_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipient_verifications" ADD CONSTRAINT "recipient_verifications_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipient_verifications" ADD CONSTRAINT "recipient_verifications_token_hash_unique" UNIQUE("token_hash");