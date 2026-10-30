CREATE TABLE "handoff_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"attempt_token_hash" text NOT NULL,
	"quote_revision" integer NOT NULL,
	"status" varchar(32) DEFAULT 'PREPARED' NOT NULL,
	"satora_swap_id" text,
	"recovery_acknowledged" boolean DEFAULT false NOT NULL,
	"handoff_authorized_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoff_attempts_attempt_token_hash_unique" UNIQUE("attempt_token_hash")
);
--> statement-breakpoint
CREATE TABLE "swap_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"satora_swap_id" text NOT NULL,
	"invoice_bolt11" text NOT NULL,
	"payment_hash" text NOT NULL,
	"source_sats" text NOT NULL,
	"target_atomic" text NOT NULL,
	"invoice_expires_at" timestamp with time zone,
	"provider_status" varchar(64),
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "swap_attachments_transfer_id_unique" UNIQUE("transfer_id"),
	CONSTRAINT "swap_attachments_satora_swap_id_unique" UNIQUE("satora_swap_id"),
	CONSTRAINT "swap_attachments_source_format" CHECK ("swap_attachments"."source_sats" ~ '^[0-9]+$'),
	CONSTRAINT "swap_attachments_target_format" CHECK ("swap_attachments"."target_atomic" ~ '^[0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "handoff_attempts" ADD CONSTRAINT "handoff_attempts_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swap_attachments" ADD CONSTRAINT "swap_attachments_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swap_attachments" ADD CONSTRAINT "swap_attachments_attempt_id_handoff_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."handoff_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handoff_attempts_transfer_idx" ON "handoff_attempts" USING btree ("transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_attempts_single_active_uidx" ON "handoff_attempts" USING btree ("transfer_id") WHERE "handoff_attempts"."status" IN ('PREPARED', 'SWAP_ATTACHED');--> statement-breakpoint
CREATE INDEX "swap_attachments_attempt_idx" ON "swap_attachments" USING btree ("attempt_id");