CREATE TABLE "payment_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"route_id" varchar(32) NOT NULL,
	"destination" text NOT NULL,
	"recipient_name" varchar(120),
	"amount_atomic" text NOT NULL,
	"cadence" varchar(16) NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"last_paid_at" timestamp with time zone,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_schedules_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade,
	CONSTRAINT "payment_schedules_cadence_check" CHECK ("cadence" IN ('weekly','monthly')),
	CONSTRAINT "payment_schedules_amount_check" CHECK ("amount_atomic" ~ '^[1-9][0-9]*$')
);
--> statement-breakpoint
CREATE INDEX "payment_schedules_owner_idx" ON "payment_schedules" USING btree ("owner_user_id","next_due_at");
