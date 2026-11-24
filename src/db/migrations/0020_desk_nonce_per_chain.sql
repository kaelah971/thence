DROP INDEX IF EXISTS "desk_wallet_nonce_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "desk_wallet_chain_nonce_idx" ON "desk_orders" USING btree ("payout_wallet", COALESCE(payload->>'chain', 'polygon'), "payout_nonce");
