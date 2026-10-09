ALTER TYPE "public"."company_website_source" ADD VALUE 'ai_verified';--> statement-breakpoint
ALTER TYPE "public"."company_website_source" ADD VALUE 'ai_guess';--> statement-breakpoint
ALTER TABLE "job_leads" ADD COLUMN "company_website_note" text;