CREATE TYPE "public"."company_linkedin_status" AS ENUM('not_checked', 'found', 'not_specified');--> statement-breakpoint
ALTER TABLE "job_leads" ADD COLUMN "company_linkedin_status" "company_linkedin_status" DEFAULT 'not_checked' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_leads" ADD COLUMN "company_linkedin_urls" text[];