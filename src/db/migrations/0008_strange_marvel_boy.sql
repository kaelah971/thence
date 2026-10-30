ALTER TABLE "transfers" ADD COLUMN "recipient_name" varchar(120);--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "quote_provider" varchar(32);--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "quote_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "quoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "quoted_net_target_atomic" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "quoted_source_sats" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "quoted_fees_json" jsonb;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "quoted_limits_json" jsonb;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_quoted_net_target_format" CHECK ("transfers"."quoted_net_target_atomic" IS NULL OR "transfers"."quoted_net_target_atomic" ~ '^[0-9]+$');--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_quoted_source_format" CHECK ("transfers"."quoted_source_sats" IS NULL OR "transfers"."quoted_source_sats" ~ '^[0-9]+$');