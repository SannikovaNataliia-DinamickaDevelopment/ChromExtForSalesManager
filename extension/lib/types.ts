// Mirrors backend/src/leads/dto/create-lead.dto.ts (CLAUDE.md data model).
export interface JobLead {
  source_site: string;
  source_url: string;
  external_job_id: string;
  job_title?: string;
  company?: string;
  company_website?: string;
  location?: string;
  description?: string;
  salary?: string;
  tech_stack?: string;
  apply_url?: string;
  ats?: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  snapshot?: Record<string, unknown>;
  scraped_at: string;
  // The vacancy's posted date, parsed from the list card; null when it couldn't be found.
  published_at?: string | null;
}

export const LEAD_STATUSES = ['new', 'in_progress', 'done'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

// CLAUDE.md scope C: broad IT/not-IT flag from Gemini, default 'unprocessed'. Never used to
// delete leads — only flags them.
export const LEAD_IS_IT_VALUES = ['it', 'not_it', 'unprocessed'] as const;
export type LeadIsIt = (typeof LEAD_IS_IT_VALUES)[number];

export interface JobLeadRecord extends JobLead {
  id: string;
  // "created_by" (shared team lead base decision log): who first parsed this lead.
  // No longer scopes visibility — GET /leads returns every user's leads.
  owner_user_id: string;
  owner_email: string | null;
  owner_display_name: string | null;
  status: LeadStatus;
  is_it: LeadIsIt;
  created_at: string;
  updated_at: string;
  // Set when a deepening attempt hit a definitive, non-retriable failure for this specific
  // lead (e.g. a Wellfound posting that 404s — removed/expired, not a bot-block or a timeout).
  // Null = no error on record. Distinct from "no description/company_website yet", which just
  // means never attempted (or worth a normal auto-retry) — see wellfound-deepen.ts.
  enrichment_error: string | null;
  // Wellfound "Hiring contact" tracking (name/role/location, scraped from the detail page's
  // DOM, distinct from contact_name/contact_email/contact_phone above which stay manual/
  // LinkedIn-only). name/role/location are only ever set when status is 'found'.
  hiring_contact_status: 'not_checked' | 'found' | 'not_specified';
  hiring_contact_name: string | null;
  hiring_contact_role: string | null;
  hiring_contact_location: string | null;
}

// FR-5: one manual click parses every card on the current list page (batch, current tab only).
export interface SiteParser {
  parseList(document: Document): JobLead[];
}
