ALTER TABLE "transfer_proofs" ADD COLUMN "evidence_source" varchar(32);--> statement-breakpoint
ALTER TABLE "transfer_proofs" ADD COLUMN "chain_id" integer;--> statement-breakpoint
ALTER TABLE "transfer_proofs" ADD COLUMN "token_contract" text;--> statement-breakpoint
ALTER TABLE "transfer_proofs" ADD COLUMN "recipient" text;--> statement-breakpoint
ALTER TABLE "transfer_proofs" ADD COLUMN "verified_amount_atomic" text;--> statement-breakpoint
ALTER TABLE "transfer_proofs" ADD COLUMN "block_number" bigint;--> statement-breakpoint
ALTER TABLE "transfer_proofs" ADD COLUMN "block_hash" text;--> statement-breakpoint
ALTER TABLE "transfer_proofs" ADD COLUMN "log_indexes" text;--> statement-breakpoint
ALTER TABLE "transfer_proofs" ADD COLUMN "finality_level" varchar(32);--> statement-breakpoint
ALTER TABLE "transfer_proofs" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_proofs_claim_uidx" ON "transfer_proofs" USING btree ("chain_id","evm_tx_hash") WHERE "transfer_proofs"."evm_tx_hash" IS NOT NULL;