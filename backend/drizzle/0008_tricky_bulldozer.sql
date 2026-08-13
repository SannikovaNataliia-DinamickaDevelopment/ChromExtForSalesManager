CREATE TYPE "public"."hiring_contact_status" AS ENUM('not_checked', 'found', 'not_specified');--> statement-breakpoint
ALTER TABLE "job_leads" ADD COLUMN "hiring_contact_status" "hiring_contact_status" DEFAULT 'not_checked' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_leads" ADD COLUMN "hiring_contact_name" text;--> statement-breakpoint
ALTER TABLE "job_leads" ADD COLUMN "hiring_contact_role" text;--> statement-breakpoint
ALTER TABLE "job_leads" ADD COLUMN "hiring_contact_location" text;