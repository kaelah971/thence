CREATE TABLE "job_leases" (
	"name" varchar(64) PRIMARY KEY NOT NULL,
	"holder" varchar(64) NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_summary" jsonb
);
