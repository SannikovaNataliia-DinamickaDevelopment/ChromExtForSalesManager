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

export type ExportColumn = {
  key: string;
  label: string;
  value: (r: JobLeadRecord) => string;
};

// CLAUDE.md's Sheet column order (published_at first) kept here too, for consistency with the
// one column order the manager already knows — even though this list is otherwise independent.
export const EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'published_at', label: 'Published', value: (r) => formatKyivDate(r.published_at) },
  { key: 'source_site', label: 'Source', value: (r) => cell(r.source_site) },
  { key: 'job_title', label: 'Title', value: (r) => cell(r.job_title) },
  { key: 'source_url', label: 'Job link', value: (r) => cell(r.source_url) },
  { key: 'is_it', label: 'IT?', value: (r) => IS_IT_LABELS[r.is_it] },
  { key: 'company', label: 'Company', value: (r) => cell(r.company) },
  { key: 'company_website', label: 'Website', value: (r) => cell(r.company_website) },
  { key: 'location', label: 'Location', value: (r) => cell(r.location) },
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
