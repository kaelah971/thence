CREATE TABLE "pilot_controls" (
	"id" text PRIMARY KEY DEFAULT 'pilot' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"note" varchar(280),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pilot_controls" ADD CONSTRAINT "pilot_controls_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- F8.2: seed the singleton kill switch DISABLED (fail-closed).
-- Fresh databases start stopped; activation is an explicit operator step.
-- Repeatable: re-running never re-enables a live switch.
INSERT INTO "pilot_controls" ("id", "enabled", "note") VALUES ('pilot', false, 'seeded disabled') ON CONFLICT ("id") DO NOTHING;