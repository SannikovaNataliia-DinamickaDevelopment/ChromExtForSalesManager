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
// AI-powered LPR (leadership) search (20.08 follow-up) — records which of the providers
// produced the currently-saved lpr_results, not a status/lifecycle enum like the two above
// (there's no "not_checked" state here: lpr_provider/lpr_results/lpr_reasoning/lpr_searched_at
// are simply all null until the first search, see job_leads below). 'apollo' added 26.08
// follow-up — a maintained lookup database (Apollo.io), not a generative model like the other
// three; see apollo-classifier.service.ts's own doc comment for how that changes its pipeline.
export const lprProviderEnum = pgEnum('lpr_provider', ['openai', 'gemini', 'claude', 'apollo']);
// Industry classification (24.08 follow-up, per the 19.08 call) — classifies the COMPANY's
// industry/vertical, not what its product technically is (a CRM vendor for the energy sector is
// "Energy," not "Software Development" — see industry-classifier.service.ts's own doc comment
// for the full rule). Fixed 20-value taxonomy, confirmed with the manager before implementation;
// expected to gain values over time as "Other" entries reveal real gaps — a new enum value only
// ever needs a migration to ADD one, never to remove/rename an existing lead's stored value.
export const industryEnum = pgEnum('industry', [
  'Real Estate', 'Healthcare', 'Banking & Financial Services', 'Insurance', 'Energy',
  'Retail & E-commerce', 'Education', 'Manufacturing', 'Transportation & Logistics',
  'Hospitality & Travel', 'Legal Services', 'Media & Entertainment', 'Telecommunications',
  'Government & Public Sector', 'Non-profit', 'Agriculture', 'Construction',
  'Software Development', 'Professional Services & Consulting', 'Other',
]);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  display_name: text('display_name'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // Dashboard column customization (Task DI-2966 "draggable/hideable columns", 14.08 call):
  // { order: string[], hidden: string[] } — per-user, DB-backed so it follows the manager
  // across devices/browsers rather than living in this browser's localStorage. Null = never
  // customized (or never saved) — the dashboard falls back to its own default order/full
  // visibility client-side; this column is never written to except via PUT /me/dashboard-columns.
  dashboard_columns: jsonb('dashboard_columns'),
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
    // AI-powered LPR search (20.08 follow-up — see leads.service.ts's lprSearch and
    // openai-classifier.service.ts). Started as an ephemeral, unpersisted per-request test
    // (gemini-classifier.service.ts / claude-classifier.service.ts); now real and persisted,
    // OpenAI-first. Overwritten (not appended/versioned) on every re-run — same "last result
    // wins, no history" convention already used by company_linkedin_urls/hiring_contact_*
    // above. All four fields are null together until the first search; lprSearch() only ever
    // writes them as a group, so a partially-populated state (e.g. results without a
    // searched_at) should never occur.
    // linkedin_url_verified (20.08 follow-up bug fix): only OpenAI populates this — see
    // openai-classifier.service.ts and LprPerson (gemini-classifier.service.ts) for why.
    lpr_results: jsonb('lpr_results').$type<
      { role: string; name: string; linkedin_url: string; linkedin_url_verified?: boolean }[]
    >(),
    lpr_reasoning: text('lpr_reasoning'),
    lpr_provider: lprProviderEnum('lpr_provider'),
    lpr_searched_at: timestamp('lpr_searched_at', { withTimezone: true }),
    // Apollo organization id cache (28.08 follow-up) — apollo-classifier.service.ts's DM search
    // used to filter by domain (q_organization_domains_list), which Apollo's own docs flag as
    // less reliable than organization_ids[] (breaks on subdomains/redirects/multi-brand domains).
    // Resolving a domain to an organization id costs 1 Apollo credit (organizations/enrich), so
    // it's resolved once per company and cached here, reused across every lead that shares the
    // same company_website domain — never re-resolved for a domain that already has one cached
    // on ANY lead. Null = not yet resolved (never attempted, or the lookup found no match — see
    // ApolloClassifierService.resolveOrganizationId's own comment on why a "no match" result
    // isn't distinguished from "not yet tried" here: both fall back to the same domain-based
    // search, so there's no behavioral reason to tell them apart, same "null means not yet, not
    // a special value" convention as lpr_provider/industry above).
    apollo_organization_id: text('apollo_organization_id'),
    apollo_organization_resolved_at: timestamp('apollo_organization_resolved_at', { withTimezone: true }),
    // Industry classification (24.08 follow-up — see industryEnum above and
    // industry-classifier.service.ts). Null = not yet classified (never attempted, or attempted
    // with no usable company_website) — same "null means not yet, not a special enum value"
    // convention as lpr_results/lpr_provider above, not a 21st "Unclassified" enum member.
    // industry_other_description is only ever populated when industry = 'Other' — the model is
    // asked to explain what the company actually does so these can be reviewed later to spot a
    // missing taxonomy category, same review-later spirit as CLAUDE.md's own "will adjust as we
    // go" framing for this taxonomy.
    industry: industryEnum('industry'),
    industry_other_description: text('industry_other_description'),
    industry_classified_at: timestamp('industry_classified_at', { withTimezone: true }),
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
