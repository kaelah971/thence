CREATE TABLE "desk_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"state" text NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"request_key" varchar(80) NOT NULL,
	"state" text NOT NULL,
	"amount_atomic" text NOT NULL,
	"payout_wallet" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"deposit_hash" text,
	"payout_hash" text,
	"payout_nonce" bigint,
	"signed_payout" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desk_orders_deposit_hash_unique" UNIQUE("deposit_hash"),
	CONSTRAINT "desk_orders_payout_hash_unique" UNIQUE("payout_hash"),
	CONSTRAINT "desk_amount_atomic_check" CHECK ("desk_orders"."amount_atomic" ~ '^[1-9][0-9]*$'),
	CONSTRAINT "desk_state_check" CHECK ("desk_orders"."state" IN ('QUOTED','AWAITING_NIM','VERIFIED','PAYOUT_PREPARED','PAYOUT_SUBMITTED','DELIVERED','REFUND_DUE','REFUNDED','EXPIRED'))
);
--> statement-breakpoint
ALTER TABLE "desk_events" ADD CONSTRAINT "desk_events_order_id_desk_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."desk_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_orders" ADD CONSTRAINT "desk_orders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "desk_owner_request_idx" ON "desk_orders" USING btree ("owner_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_wallet_nonce_idx" ON "desk_orders" USING btree ("payout_wallet","payout_nonce");--> statement-breakpoint
CREATE INDEX "desk_pending_idx" ON "desk_orders" USING btree ("state");