ALTER TABLE "payment_requests" ADD COLUMN "recipient_name" varchar(120) NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "cancelled_at" timestamp with time zone;