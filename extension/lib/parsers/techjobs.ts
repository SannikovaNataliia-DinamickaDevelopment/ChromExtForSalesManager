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
 * List cards don't carry company/company_website/salary/description/tech_stack/apply_url/
 * ats/contact_* — those keys are omitted here (not sent as '') so a list re-parse's dedup
 * UPDATE never clobbers values the "deepen" step (scope B) already filled in.
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
        scraped_at,
        published_at,
        snapshot: { employment_type, seniority, posted },
      };
      return lead;
    });
  }
}

export interface TechjobsDetail {
  description: string;
  company: string;
  company_website: string;
  published_at: string | null;
}

interface JobPostingJsonLd {
  '@type'?: string;
  description?: string;
  datePosted?: string;
  hiringOrganization?: { name?: string; sameAs?: string };
}

function isJobPosting(value: unknown): value is JobPostingJsonLd {
  return !!value && typeof value === 'object' && (value as JobPostingJsonLd)['@type'] === 'JobPosting';
}

/**
 * Techjobs.ca detail page parser (CLAUDE.md "Parser spec" — DETAIL, scope B).
 * The detail page's initial (server-rendered) HTML embeds a clean JSON-LD JobPosting —
 * confirmed against a live-fetched page and spikes/techjobs_detail.html — so this parses
 * plain fetched HTML text via regex, never a DOM (must also run in a background/service-worker
 * context with no `document`). Returns null (never throws) if no JobPosting block is found.
 *
 * Caveat (per manager): hiringOrganization is sometimes the reposting board, not the true
 * employer — the real company may only be in the description. Fine for MVP; we store
 * hiringOrganization.name/sameAs as-is.
 */
export function parseTechjobsDetail(html: string): TechjobsDetail | null {
  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRe.exec(html))) {
    let data: unknown;
    try {
      data = JSON.parse(match[1]);
    } catch {
      continue;
    }

    const posting = Array.isArray(data) ? data.find(isJobPosting) : isJobPosting(data) ? data : undefined;
    if (!posting) continue;

    const datePosted = posting.datePosted ? new Date(posting.datePosted) : null;
    return {
      description: typeof posting.description === 'string' ? posting.description : '',
      company: posting.hiringOrganization?.name ?? '',
      company_website: posting.hiringOrganization?.sameAs ?? '',
      published_at: datePosted && !Number.isNaN(datePosted.getTime()) ? datePosted.toISOString() : null,
    };
  }

  return null;
}
