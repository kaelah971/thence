CREATE TABLE "reconciliation_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"satora_swap_id" text NOT NULL,
	"provider_status" varchar(64) NOT NULL,
	"kind" varchar(32) DEFAULT 'observation' NOT NULL,
	"error_code" varchar(64),
	"evm_fund_txid" text,
	"evm_claim_txid" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_observations_kind_format" CHECK ("reconciliation_observations"."kind" IN ('observation', 'provider_error', 'identity_mismatch'))
);
--> statement-breakpoint
ALTER TABLE "reconciliation_observations" ADD CONSTRAINT "reconciliation_observations_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_observations_transfer_idx" ON "reconciliation_observations" USING btree ("transfer_id","observed_at");