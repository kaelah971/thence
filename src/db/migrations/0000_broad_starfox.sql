CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nimiq_address" varchar(128) NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_challenges_challenge_unique" UNIQUE("challenge")
);
--> statement-breakpoint
CREATE TABLE "payment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_user_id" uuid NOT NULL,
	"public_id" varchar(64) NOT NULL,
	"asset" varchar(16) NOT NULL,
	"network" varchar(32) NOT NULL,
	"destination" text NOT NULL,
	"amount_atomic" text NOT NULL,
	"memo" varchar(280),
	"expires_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_requests_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payment_requests_amount_atomic_format" CHECK ("payment_requests"."amount_atomic" ~ '^[0-9]+$'),
	CONSTRAINT "payment_requests_destination_nonempty" CHECK (char_length("payment_requests"."destination") > 0)
);
--> statement-breakpoint
CREATE TABLE "recipient_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" uuid NOT NULL,
	"asset" varchar(16) NOT NULL,
	"network" varchar(32) NOT NULL,
	"address" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"verification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipient_destinations_address_nonempty" CHECK (char_length("recipient_destinations"."address") > 0)
);
--> statement-breakpoint
CREATE TABLE "recipient_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"network" varchar(32) NOT NULL,
	"challenge" text NOT NULL,
	"signature" text,
	"verified_at" timestamp with time zone,
	"verified_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipient_verifications_challenge_unique" UNIQUE("challenge"),
	CONSTRAINT "recipient_verifications_address_nonempty" CHECK (char_length("recipient_verifications"."address") > 0)
);
--> statement-breakpoint
CREATE TABLE "recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipients_display_name_nonempty" CHECK (char_length("recipients"."display_name") > 0)
);
--> statement-breakpoint
CREATE TABLE "route_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" varchar(32) NOT NULL,
	"min_atomic" text,
	"max_atomic" text,
	"fee_atomic" text,
	"bridge_fee_atomic" text,
	"source" varchar(64) DEFAULT 'satora-quote' NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_observations_min_format" CHECK ("route_observations"."min_atomic" IS NULL OR "route_observations"."min_atomic" ~ '^[0-9]+$'),
	CONSTRAINT "route_observations_max_format" CHECK ("route_observations"."max_atomic" IS NULL OR "route_observations"."max_atomic" ~ '^[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfer_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"nimiq_tx_hash" text,
	"lightning_hash" text,
	"satora_swap_id" text,
	"evm_tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_proofs_transfer_id_unique" UNIQUE("transfer_id")
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"recipient_id" uuid,
	"request_id" uuid,
	"route_id" varchar(32) NOT NULL,
	"target_asset" varchar(16) NOT NULL,
	"target_network" varchar(32) NOT NULL,
	"destination" text NOT NULL,
	"target_amount_atomic" text NOT NULL,
	"status" varchar(32) DEFAULT 'DRAFT' NOT NULL,
	"idempotency_key" varchar(128),
	"quote_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_amount_atomic_format" CHECK ("transfers"."target_amount_atomic" ~ '^[0-9]+$'),
	CONSTRAINT "transfers_destination_nonempty" CHECK (char_length("transfers"."destination") > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nimiq_address" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_nimiq_address_unique" UNIQUE("nimiq_address")
);
--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipient_destinations" ADD CONSTRAINT "recipient_destinations_recipient_id_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipient_destinations" ADD CONSTRAINT "recipient_destinations_verification_id_recipient_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."recipient_verifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipient_verifications" ADD CONSTRAINT "recipient_verifications_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_proofs" ADD CONSTRAINT "transfer_proofs_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_recipient_id_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_request_id_payment_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."payment_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_challenges_address_idx" ON "auth_challenges" USING btree ("nimiq_address");--> statement-breakpoint
CREATE INDEX "auth_challenges_expires_idx" ON "auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "payment_requests_creator_idx" ON "payment_requests" USING btree ("creator_user_id");--> statement-breakpoint
CREATE INDEX "payment_requests_expires_idx" ON "payment_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "recipient_destinations_recipient_idx" ON "recipient_destinations" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "recipient_destinations_address_network_idx" ON "recipient_destinations" USING btree ("address","network");--> statement-breakpoint
CREATE UNIQUE INDEX "recipient_verifications_address_network_uidx" ON "recipient_verifications" USING btree ("address","network");--> statement-breakpoint
CREATE INDEX "recipient_verifications_address_idx" ON "recipient_verifications" USING btree ("address");--> statement-breakpoint
CREATE INDEX "recipients_owner_idx" ON "recipients" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "recipients_owner_archived_idx" ON "recipients" USING btree ("owner_user_id","archived_at");--> statement-breakpoint
CREATE INDEX "route_observations_route_observed_idx" ON "route_observations" USING btree ("route_id","observed_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "transfers_owner_idx" ON "transfers" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "transfers_owner_status_idx" ON "transfers" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "transfers_recipient_idx" ON "transfers" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "transfers_status_idx" ON "transfers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_owner_idempotency_uidx" ON "transfers" USING btree ("owner_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");