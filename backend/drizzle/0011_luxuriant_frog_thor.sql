CREATE TYPE "public"."lpr_provider" AS ENUM('openai', 'gemini', 'claude');--> statement-breakpoint
ALTER TABLE "job_leads" ADD COLUMN "lpr_results" jsonb;--> statement-breakpoint
ALTER TABLE "job_leads" ADD COLUMN "lpr_reasoning" text;--> statement-breakpoint
ALTER TABLE "job_leads" ADD COLUMN "lpr_provider" "lpr_provider";--> statement-breakpoint
ALTER TABLE "job_leads" ADD COLUMN "lpr_searched_at" timestamp with time zone;