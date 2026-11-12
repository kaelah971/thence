CREATE TABLE "transfer_source_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"nimiq_tx_hash" text NOT NULL,
	"verdict" varchar(16) NOT NULL,
	"failure_code" varchar(64),
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verifier_version" varchar(64) NOT NULL,
	"rpc_source" varchar(256) NOT NULL,
	"finality_policy" varchar(64) NOT NULL,
	"operator_ref" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_source_evidence_hash_format" CHECK ("transfer_source_evidence"."nimiq_tx_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "transfer_source_evidence_verdict_format" CHECK ("transfer_source_evidence"."verdict" IN ('VERIFIED', 'REJECTED')),
	CONSTRAINT "transfer_source_evidence_failure_consistent" CHECK (("transfer_source_evidence"."verdict" = 'VERIFIED' AND "transfer_source_evidence"."failure_code" IS NULL) OR ("transfer_source_evidence"."verdict" = 'REJECTED' AND "transfer_source_evidence"."failure_code" IS NOT NULL)),
	CONSTRAINT "transfer_source_evidence_evidence_bounded" CHECK (jsonb_typeof("transfer_source_evidence"."evidence") = 'object' AND pg_column_size("transfer_source_evidence"."evidence") <= 8192),
	CONSTRAINT "transfer_source_evidence_operator_ref_present" CHECK (length(btrim("transfer_source_evidence"."operator_ref")) > 0)
);
--> statement-breakpoint
ALTER TABLE "transfer_source_evidence" ADD CONSTRAINT "transfer_source_evidence_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfer_source_evidence_transfer_idx" ON "transfer_source_evidence" USING btree ("transfer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_source_evidence_verified_transfer_uidx" ON "transfer_source_evidence" USING btree ("transfer_id") WHERE "transfer_source_evidence"."verdict" = 'VERIFIED';--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_source_evidence_verified_hash_uidx" ON "transfer_source_evidence" USING btree ("nimiq_tx_hash") WHERE "transfer_source_evidence"."verdict" = 'VERIFIED';--> statement-breakpoint
CREATE OR REPLACE FUNCTION "transfer_source_evidence_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'transfer_source_evidence is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "transfer_source_evidence_no_update_delete" BEFORE UPDATE OR DELETE ON "transfer_source_evidence" FOR EACH ROW EXECUTE FUNCTION "transfer_source_evidence_append_only"();--> statement-breakpoint
CREATE TRIGGER "transfer_source_evidence_no_truncate" BEFORE TRUNCATE ON "transfer_source_evidence" FOR EACH STATEMENT EXECUTE FUNCTION "transfer_source_evidence_append_only"();
