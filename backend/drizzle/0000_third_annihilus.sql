CREATE TYPE "public"."lead_status" AS ENUM('new', 'in_progress', 'done');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source_site" text NOT NULL,
	"source_url" text NOT NULL,
	"external_job_id" text NOT NULL,
	"company" text,
	"job_title" text,
	"location" text,
	"description" text,
	"salary" text,
	"tech_stack" text,
	"apply_url" text,
	"ats" text,
	"contact_name" text,
	"contact_email" text,
	"contact_phone" text,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"snapshot" jsonb,
	"scraped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_leads" ADD CONSTRAINT "job_leads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_leads_owner_site_job_id_idx" ON "job_leads" USING btree ("owner_user_id","source_site","external_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_leads_owner_source_url_idx" ON "job_leads" USING btree ("owner_user_id","source_url");