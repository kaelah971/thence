CREATE TABLE "transfer_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"from_status" varchar(32) NOT NULL,
	"to_status" varchar(32) NOT NULL,
	"actor" varchar(16) NOT NULL,
	"actor_user_id" uuid,
	"reason_code" varchar(64) NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"terminal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_transitions_actor_format" CHECK ("transfer_transitions"."actor" IN ('owner', 'reconciler', 'operator'))
);
--> statement-breakpoint
ALTER TABLE "transfer_transitions" ADD CONSTRAINT "transfer_transitions_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_transitions" ADD CONSTRAINT "transfer_transitions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfer_transitions_transfer_idx" ON "transfer_transitions" USING btree ("transfer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_transitions_terminal_once" ON "transfer_transitions" USING btree ("transfer_id") WHERE "transfer_transitions"."terminal" = true;