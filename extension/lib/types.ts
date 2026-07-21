// Mirrors backend/src/leads/dto/create-lead.dto.ts (CLAUDE.md data model).
export interface JobLead {
  source_site: string;
  source_url: string;
  external_job_id: string;
  job_title?: string;
  company?: string;
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
}

export const LEAD_STATUSES = ['new', 'in_progress', 'done'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface JobLeadRecord extends JobLead {
  id: string;
  // "created_by" (shared team lead base decision log): who first parsed this lead.
  // No longer scopes visibility — GET /leads returns every user's leads.
  owner_user_id: string;
  owner_email: string | null;
  owner_display_name: string | null;
  status: LeadStatus;
  created_at: string;
  updated_at: string;
}

// FR-5: one manual click parses every card on the current list page (batch, current tab only).
export interface SiteParser {
  parseList(document: Document): JobLead[];
}
