CREATE TYPE "public"."lead_is_it" AS ENUM('it', 'not_it', 'unprocessed');--> statement-breakpoint
ALTER TABLE "job_leads" ADD COLUMN "is_it" "lead_is_it" DEFAULT 'unprocessed' NOT NULL;