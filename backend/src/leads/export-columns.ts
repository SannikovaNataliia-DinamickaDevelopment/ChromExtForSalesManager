import { formatKyivDate, formatKyivDateTime } from '../common/format-kyiv-time';
import type { JobLeadRecord } from '../destinations/destination.interface';

// Dashboard "Export" (xlsx). Same "single source of truth for column order" pattern as
// sheets.destination.ts's own COLUMNS array — this is a second, independent output (a
// downloaded file, not the live Sheet), so it gets its own list rather than reusing that one:
// the two are allowed to diverge (e.g. this one exposes a stable `key` for the advanced
// export's column-selection checkboxes, which the Sheet has no use for).
const IS_IT_LABELS: Record<JobLeadRecord['is_it'], string> = { it: 'IT', not_it: 'not-IT', unprocessed: '' };
const STATUS_LABELS: Record<JobLeadRecord['status'], string> = {
  new: 'новий',
  in_progress: 'опрацьовується',
  done: 'опрацьований',
};

function cell(value: string | null | undefined): string {
  return value ?? '';
}

// Wellfound's description legitimately contains real HTML (confirmed against production data
// when fixing the dashboard sidebar's HTML-as-literal-text bug — see dashboard-page.ts's
// sanitizeDescriptionHtml). A spreadsheet cell has no HTML rendering context, so unlike the
// dashboard sidebar this doesn't sanitize-to-safe-HTML — it strips markup down to plain text,
// same failure this is avoiding: '<p><strong>OVERVIEW</strong></p>' showing up as literal
// visible text, this time in Excel instead of the browser. techjobs/itjobs descriptions have
// no '<' at all, so they pass through byte-identical.
function plainTextCell(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Same not_checked/found/not_specified convention as the dashboard sidebar's own
// hiringContactDetailValue/buildCompanyLinkedinRow (dashboard-page.ts) — 'не вказано' for a
// definitively-checked-and-empty result, blank for not yet checked, joined URL list when found.
function companyLinkedinCell(r: JobLeadRecord): string {
  if (r.company_linkedin_status === 'found' && r.company_linkedin_urls && r.company_linkedin_urls.length > 0) {
    return r.company_linkedin_urls.join(', ');
  }
  if (r.company_linkedin_status === 'not_specified') return 'не вказано';
  return '';
}

// Same not_checked/found/not_specified convention as the dashboard sidebar's own
// hiringContactDetailValue (dashboard-page.ts) — "Name — Role (Location)" when found, each of
// role/location omitted individually when absent, 'не вказано' for a definitively-checked-and-
// empty result, blank for not yet checked (Wellfound only; other sources never populate this).
function hiringContactCell(r: JobLeadRecord): string {
  if (r.hiring_contact_status === 'found') {
    let text = r.hiring_contact_name || '';
    if (r.hiring_contact_role) text += ' — ' + r.hiring_contact_role;
    if (r.hiring_contact_location) text += ' (' + r.hiring_contact_location + ')';
    return text;
  }
  if (r.hiring_contact_status === 'not_specified') return 'не вказано';
  return '';
}

// AI-powered LPR search (20.08 follow-up) — one line per person, "\n"-separated so a spreadsheet
// cell with wrap-text shows each entry on its own line, same "role + clickable link, one per
// line" spirit as the dashboard table/sidebar (a spreadsheet cell has no link-rendering context
// though, so this is the plain-URL equivalent — see the dashboard's own buildCompanyLinkedinRow
// comment on why that one similarly doesn't try to fake a hyperlink here). No not_checked/found/
// not_specified three-state here (unlike Company LinkedIn/Hiring Contact above) — lpr_results is
// simply null until the first search, empty array after a search that found nobody.
function lprCell(r: JobLeadRecord): string {
  const people = r.lpr_results;
  if (!people || people.length === 0) return '';
  // linkedin_url_verified === false (20.08 follow-up bug fix): linkedin_url is already blanked
  // by openai-classifier.service.ts in this case — same "(unverified)" note as the dashboard's
  // buildLprResultsRow/buildLprTd, so a manager reading the export doesn't mistake a blank URL
  // for "nothing found" when a real name/role was.
  return people
    .map((p) => `${p.role}: ${p.name}${p.linkedin_url ? ' — ' + p.linkedin_url : ''}${p.linkedin_url_verified === false ? ' (unverified)' : ''}`)
    .join('\n');
}

export type ExportColumn = {
  key: string;
  label: string;
  value: (r: JobLeadRecord) => string;
};

// Default/fallback order only (see leads.service.ts's exportXlsx): when the caller (dashboard
// "Export" button) sends an explicit `columns` list, THAT order wins — the dashboard's own
// ALL_COLUMNS-driven, per-user-customizable order (Task DI-2966 draggable columns) is the real
// source of truth for what a manager sees in the file. This array's order is only what's used
// when no explicit order is given (e.g. a direct API call) — kept matching the dashboard's
// default column order (Oleksandr's 14.08 sequence) for consistency, not because it's load-bearing.
export const EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'published_at', label: 'Published', value: (r) => formatKyivDate(r.published_at) },
  { key: 'source_site', label: 'Source', value: (r) => cell(r.source_site) },
  { key: 'job_title', label: 'Title', value: (r) => cell(r.job_title) },
  { key: 'company', label: 'Company', value: (r) => cell(r.company) },
  { key: 'company_website', label: 'Website', value: (r) => cell(r.company_website) },
  { key: 'location', label: 'Location', value: (r) => cell(r.location) },
  { key: 'company_linkedin', label: 'Company LinkedIn', value: (r) => companyLinkedinCell(r) },
  { key: 'hiring_contact', label: 'Hiring Contact', value: (r) => hiringContactCell(r) },
  { key: 'lpr', label: 'LPR', value: (r) => lprCell(r) },
  { key: 'source_url', label: 'Job link', value: (r) => cell(r.source_url) },
  { key: 'is_it', label: 'IT?', value: (r) => IS_IT_LABELS[r.is_it] },
  { key: 'salary', label: 'Salary', value: (r) => cell(r.salary) },
  { key: 'tech_stack', label: 'Tech stack', value: (r) => cell(r.tech_stack) },
  { key: 'description', label: 'Description', value: (r) => plainTextCell(r.description) },
  { key: 'apply_url', label: 'Apply link', value: (r) => cell(r.apply_url) },
  { key: 'ats', label: 'ATS', value: (r) => cell(r.ats) },
  { key: 'external_job_id', label: 'External job ID', value: (r) => cell(r.external_job_id) },
  { key: 'status', label: 'Status', value: (r) => STATUS_LABELS[r.status] },
  { key: 'owner', label: 'Owner', value: (r) => cell(r.owner_display_name || r.owner_email) },
  { key: 'scraped_at', label: 'Scraped (Kyiv)', value: (r) => formatKyivDateTime(r.scraped_at) },
  { key: 'created_at', label: 'Created (Kyiv)', value: (r) => formatKyivDateTime(r.created_at) },
];

export const EXPORT_COLUMN_KEYS = EXPORT_COLUMNS.map((c) => c.key);
