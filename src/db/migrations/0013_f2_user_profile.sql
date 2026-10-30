ALTER TABLE "users" ADD COLUMN "display_name" varchar(32);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_display_name_nonempty" CHECK ("users"."display_name" IS NULL OR char_length("users"."display_name") > 0);