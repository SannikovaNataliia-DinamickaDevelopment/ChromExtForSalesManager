import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, jsonb } from 'drizzle-orm/pg-core';

export const leadStatusEnum = pgEnum('lead_status', ['new', 'in_progress', 'done']);
export const leadIsItEnum = pgEnum('lead_is_it', ['it', 'not_it', 'unprocessed']);
// Wellfound-only "Hiring contact" section (name/role/location), scraped from the detail page's
// live DOM — a genuinely different concept from contact_name/contact_email/contact_phone below,
// which stay manual/LinkedIn-only per CLAUDE.md. Three states, not a boolean: 'not_checked' (no
// deepening visit has looked for this yet) must be distinguishable from 'not_specified' (a visit
// looked and the section genuinely wasn't on the page) so a backfill run never re-visits a lead
// that already resolved to "no contact" — see wellfound-contact-backfill.ts.
export const hiringContactStatusEnum = pgEnum('hiring_contact_status', ['not_checked', 'found', 'not_specified']);
// Company-LinkedIn discovery: a plain fetch() of the lead's own company_website, scanning for
// <a href> values containing "linkedin.com" — no AI/LLM disambiguation this pass, just every
// unique link collected as-is (company-linkedin.service.ts). Same three-state shape as
// hiringContactStatusEnum above and same reason: 'not_checked' must be distinguishable from
// 'not_specified' (fetched fine, genuinely no LinkedIn link on the page — or the fetch itself
// failed, treated the same per spec) so a backfill run never re-touches an already-resolved lead.
export const companyLinkedinStatusEnum = pgEnum('company_linkedin_status', ['not_checked', 'found', 'not_specified']);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  display_name: text('display_name'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const external_identities = pgTable('external_identities', {
  id: uuid('id').defaultRandom().primaryKey(),
  user_id: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  provider_user_id: text('provider_user_id').notNull(),
  email: text('email'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const job_leads = pgTable(
  'job_leads',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Semantically "created_by": the user who first parsed this lead (shared team lead
    // base decision log). Column name kept as owner_user_id to avoid a disruptive rename;
    // it no longer scopes visibility or dedup, only records/attributes authorship.
    owner_user_id: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    source_site: text('source_site').notNull(),
    source_url: text('source_url').notNull(),
    external_job_id: text('external_job_id').notNull(),
    company: text('company'),
    // Filled by the deepen step (CLAUDE.md scope B): hiringOrganization.sameAs from the
    // detail page's JSON-LD JobPosting. Sometimes a reposting board, not the true employer.
    company_website: text('company_website'),
    job_title: text('job_title'),
    location: text('location'),
    description: text('description'),
    salary: text('salary'),
    tech_stack: text('tech_stack'),
    apply_url: text('apply_url'),
    ats: text('ats'),
    contact_name: text('contact_name'),
    contact_email: text('contact_email'),
    contact_phone: text('contact_phone'),
    // Wellfound "Hiring contact" section (see hiringContactStatusEnum above). Name/role/location
    // are only ever populated when status is 'found' — null in both other states.
    hiring_contact_status: hiringContactStatusEnum('hiring_contact_status').default('not_checked').notNull(),
    hiring_contact_name: text('hiring_contact_name'),
    hiring_contact_role: text('hiring_contact_role'),
    hiring_contact_location: text('hiring_contact_location'),
    // Company-LinkedIn discovery (see companyLinkedinStatusEnum above). urls is null until
    // checked; an empty array (not null) once checked and genuinely nothing was found — only
    // the status field is load-bearing for "checked or not", but an explicit [] vs. null makes
    // "checked, found nothing" distinguishable from "never checked" even by inspecting the
    // array alone.
    company_linkedin_status: companyLinkedinStatusEnum('company_linkedin_status').default('not_checked').notNull(),
    company_linkedin_urls: text('company_linkedin_urls').array(),
    status: leadStatusEnum('status').default('new').notNull(),
    // CLAUDE.md scope C: broad IT/not-IT flag from Gemini, never used to delete leads.
    is_it: leadIsItEnum('is_it').default('unprocessed').notNull(),
    // Set when a deepening attempt (TabDeepening, currently — any future strategy could set it
    // too) hits a definitive, non-retriable failure for this specific lead (e.g. a Wellfound
    // posting that 404s because it was removed/expired) — distinct from "not yet attempted"
    // (still null description/company_website with no error) so automatic deepen queues can
    // skip it instead of retrying forever. Null = no error on record. Cleared automatically the
    // next time a deepen call actually saves real content (LeadsService.deepen) — i.e. a
    // successful manual retry clears it.
    enrichment_error: text('enrichment_error'),
    snapshot: jsonb('snapshot'),
    // The vacancy's posted date (parsed from the list card), distinct from scraped_at
    // (when we parsed it) and created_at (when the row was first saved).
    published_at: timestamp('published_at', { withTimezone: true }),
    scraped_at: timestamp('scraped_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // Soft delete (retention window, dashboard "Deleted Leads" page): null = active/visible
    // everywhere. Every listing query must filter this out by default (see LeadsService).
    // Permanent removal is a separate, later step — see lead-retention.ts's purge job.
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    // Global dedup (shared team lead base, decision log): one row per posting across
    // all users, not per-owner. owner_user_id is kept as "created_by" (see below),
    // never part of the dedup key.
    site_job_id_unique: uniqueIndex('job_leads_site_job_id_idx').on(
      table.source_site,
      table.external_job_id,
    ),
    source_url_unique: uniqueIndex('job_leads_source_url_idx').on(table.source_url),
    // Dashboard stats strip's "new today" range query (LeadsService.getStats) filters
    // scraped_at over almost-always-non-deleted rows — a partial index scoped to that (the
    // overwhelmingly common case) keeps the range scan cheap as the table grows, without
    // paying index-maintenance cost for the rare soft-deleted rows. The stats strip's other
    // three counts (total, by source, by IT) inherently touch nearly every non-deleted row
    // no matter what — an index can't turn "count almost all of them" into anything cheaper
    // than a scan, so it isn't worth indexing those individually at this table's scale.
    scraped_at_active_idx: index('job_leads_scraped_at_active_idx')
      .on(table.scraped_at)
      .where(sql`${table.deleted_at} is null`),
  }),
);
