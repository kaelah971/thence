CREATE TABLE "auth_rate_limits" (
	"key" varchar(160) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_challenges" ALTER COLUMN "nimiq_address" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_rate_limits_key_window_uidx" ON "auth_rate_limits" USING btree ("key","window_start");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash");