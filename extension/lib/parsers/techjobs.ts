import type { JobLead, SiteParser } from '../types';

const BASE_URL = 'https://www.techjobs.ca';
const INFO_SPAN_SELECTOR = 'span.text-sm.text-gray-700';
const POSTED_DATE_RE = /^Posted\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

// Parses "Posted M/D/YYYY" into an ISO date string; returns null (never throws) when the
// text is missing or doesn't match, per CLAUDE.md ("keep it null if not found, don't crash").
function parsePostedDate(text: string | undefined): string | null {
  const match = text ? POSTED_DATE_RE.exec(text) : null;
  if (!match) return null;

  const [, month, day, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString();
}

/**
 * Techjobs.ca list parser (CLAUDE.md "Parser spec" — SHALLOW).
 * Techjobs is Next.js/RSC: this parses the rendered DOM, never `self.__next_f`.
 * List cards don't carry company/salary/description/tech_stack/apply_url/ats/contact_* —
 * those stay empty here and are only ever filled by a separate manual per-lead "deepen" action.
 */
export class TechjobsListParser implements SiteParser {
  parseList(document: Document): JobLead[] {
    const cards = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/job/"]'));
    const scraped_at = new Date().toISOString();

    return cards.map((card) => {
      const href = card.getAttribute('href') ?? '';
      const external_job_id = href.split('/').filter(Boolean).pop() ?? '';
      const source_url = `${BASE_URL}${href}`;
      const job_title = card.querySelector('h3')?.textContent?.trim() ?? '';

      const infoSpans = Array.from(card.querySelectorAll(INFO_SPAN_SELECTOR));
      const location = infoSpans[0]?.textContent?.trim() ?? '';
      const employment_type = infoSpans[1]?.textContent?.trim();
      const seniority = infoSpans[2]?.textContent?.trim();

      const posted = Array.from(card.querySelectorAll('span'))
        .map((el) => el.textContent?.trim())
        .find((text): text is string => !!text && text.startsWith('Posted '));
      const published_at = parsePostedDate(posted);

      const lead: JobLead = {
        source_site: 'techjobs',
        source_url,
        external_job_id,
        job_title,
        location,
        company: '',
        salary: '',
        description: '',
        tech_stack: '',
        apply_url: '',
        ats: '',
        contact_name: '',
        contact_email: '',
        contact_phone: '',
        scraped_at,
        published_at,
        snapshot: { employment_type, seniority, posted },
      };
      return lead;
    });
  }
}
