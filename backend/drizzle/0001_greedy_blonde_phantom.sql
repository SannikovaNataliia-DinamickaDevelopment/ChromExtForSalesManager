DROP INDEX IF EXISTS "job_leads_owner_site_job_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "job_leads_owner_source_url_idx";--> statement-breakpoint
-- Shared team lead base (decision log): dedup moves from per-owner to global.
-- De-duplicate existing rows before the new global unique indexes are created below,
-- keeping the earliest row (by created_at, then id as a tiebreak) per group.
DELETE FROM "job_leads" a
USING "job_leads" b
WHERE a.source_site = b.source_site
  AND a.external_job_id = b.external_job_id
  AND (a.created_at, a.id) > (b.created_at, b.id);--> statement-breakpoint
DELETE FROM "job_leads" a
USING "job_leads" b
WHERE a.source_url = b.source_url
  AND (a.created_at, a.id) > (b.created_at, b.id);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_leads_site_job_id_idx" ON "job_leads" USING btree ("source_site","external_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_leads_source_url_idx" ON "job_leads" USING btree ("source_url");