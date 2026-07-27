import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, jsonb } from 'drizzle-orm/pg-core';

export const leadStatusEnum = pgEnum('lead_status', ['new', 'in_progress', 'done']);

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
    status: leadStatusEnum('status').default('new').notNull(),
    snapshot: jsonb('snapshot'),
    // The vacancy's posted date (parsed from the list card), distinct from scraped_at
    // (when we parsed it) and created_at (when the row was first saved).
    published_at: timestamp('published_at', { withTimezone: true }),
    scraped_at: timestamp('scraped_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
  }),
);
