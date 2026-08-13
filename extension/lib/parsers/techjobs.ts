import type { JobLead, SiteParser } from '../types';

const CARD_SELECTOR = 'article';
const JOB_LINK_SELECTOR = 'a[href*="/jobs/"]';
const TITLE_SELECTOR = 'h2';
// shadcn/ui-style semantic utility class (not an arbitrary spacing/layout one) — confirmed live
// on both techjobs.ca and itjobs.ca, the one line on a card holding "[City, Province ·]
// Workplace type · relative time".
const META_SELECTOR = 'p.text-muted-foreground';
// The platform's actual persistent job id is a 12-hex-char fragment at the end of the slug
// (e.g. ".../pension-technician-canada-3442b1da6bd9") — confirmed live on many cards, always
// exactly 12 lowercase hex chars. Extracting just this fragment, not the whole path segment,
// mirrors what the old UUID-based id extraction was actually for: a stable id that survives an
// employer editing the job title (which would change the rest of the slug).
const JOB_ID_RE = /-([0-9a-f]{12})$/;

/**
 * List parser for Techjobs.ca and itjobs.ca (same template — CLAUDE.md "Parser spec"; template
 * parity re-confirmed live after both sites were redesigned, see below). `sourceSite`/`baseUrl`
 * are the only things that differ between deployments of this template.
 *
 * Rewritten for a site redesign (confirmed live): the old `a[href^="/job/"]` card markup and
 * "Posted M/D/YYYY" absolute date are both gone. Cards are now `<article>` elements; the job
 * link matches `/{company-slug}/jobs/{title-slug}-{12hexid}` instead of `/job/{uuid}`; the list
 * only shows a RELATIVE posted time ("2 hours ago") next to a workplace-type label, no absolute
 * date — same limitation Wellfound already has, handled the same way (see published_at below).
 * The list now also shows company name directly (it didn't before), so that's captured here
 * too instead of waiting for deepening to fill it in.
 */
export class TechjobsListParser implements SiteParser {
  constructor(
    private readonly sourceSite: string,
    private readonly baseUrl: string,
  ) {}

  parseList(document: Document): JobLead[] {
    const cards = Array.from(document.querySelectorAll<HTMLElement>(CARD_SELECTOR));
    const scraped_at = new Date().toISOString();

    const leads: JobLead[] = [];
    for (const card of cards) {
      const href = card.querySelector<HTMLAnchorElement>(JOB_LINK_SELECTOR)?.getAttribute('href') ?? '';
      const idMatch = JOB_ID_RE.exec(href);
      if (!href || !idMatch) continue; // not a real job card — skip rather than save garbage

      const external_job_id = idMatch[1];
      const source_url = `${this.baseUrl}${href}`;

      const titleEl = card.querySelector(TITLE_SELECTOR);
      const job_title = titleEl?.textContent?.trim() ?? '';
      // Company sits in the paragraph inside the title heading's next sibling — structural
      // relationship rather than an exact utility-class match, since those are the most likely
      // thing to shift again in a future redesign; the heading-then-company layout is more
      // durable than any one Tailwind class string.
      const company = titleEl?.nextElementSibling?.querySelector('p')?.textContent?.trim() ?? '';

      const metaText = card.querySelector(META_SELECTOR)?.textContent?.trim() ?? '';
      // "City, Province · Workplace · 2 hours ago" when a location is set, "Workplace · 2 hours
      // ago" when it isn't (both confirmed live) — the last segment is always the relative
      // time, the one before it always the workplace type, anything earlier is location.
      const metaParts = metaText.split('·').map((s) => s.trim()).filter(Boolean);
      const posted_relative = metaParts[metaParts.length - 1];
      const workplace_type = metaParts.length >= 2 ? metaParts[metaParts.length - 2] : undefined;
      const location = metaParts.length >= 3 ? metaParts.slice(0, -2).join(' · ') : '';

      leads.push({
        source_site: this.sourceSite,
        source_url,
        external_job_id,
        job_title,
        company,
        location,
        scraped_at,
        // No absolute date on the list anymore — null here, backfilled from the detail page's
        // JSON-LD datePosted during deepening, the same backfill-only mechanism already used
        // for Wellfound and for a Techjobs card whose date couldn't be parsed before.
        published_at: null,
        snapshot: { workplace_type, posted_relative },
      });
    }
    return leads;
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

// The redesigned site wraps JSON-LD in a `@graph` array alongside other entities (e.g.
// BreadcrumbList) instead of emitting a single JobPosting object or a bare array of them —
// confirmed live. Checked last (after the two previously-supported shapes) since either of
// those could still show up on a page the redesign hasn't touched.
function findJobPosting(data: unknown): JobPostingJsonLd | undefined {
  if (isJobPosting(data)) return data;
  if (Array.isArray(data)) return data.find(isJobPosting);
  if (data && typeof data === 'object' && Array.isArray((data as { '@graph'?: unknown })['@graph'])) {
    return (data as { '@graph': unknown[] })['@graph'].find(isJobPosting);
  }
  return undefined;
}

/**
 * Techjobs.ca detail page parser (CLAUDE.md "Parser spec" — DETAIL, scope B).
 * The detail page's initial (server-rendered) HTML embeds a JSON-LD JobPosting (shape updated
 * for the site redesign — see findJobPosting above) — so this parses plain fetched HTML text
 * via regex, never a DOM (must also run in a background/service-worker context with no
 * `document`). Returns null (never throws) if no JobPosting block is found.
 *
 * Two things confirmed live post-redesign, neither a parsing bug — this function correctly
 * surfaces both as-is:
 * - `description` is sometimes just "See the employer's original posting for the complete role
 *   description." for aggregated/externally-sourced listings that have no real text on this
 *   site at all (other listings, posted more directly, still have the full real description —
 *   confirmed 4000+ chars on one such listing).
 * - `hiringOrganization.sameAs` now always points back to the employer's Techjobs.ca profile
 *   page, never their real external site — a step down from the "sometimes the reposting
 *   board, sometimes real" behavior the original CLAUDE.md caveat described, but the same
 *   "store as-is, fine for MVP" handling still applies.
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

    const posting = findJobPosting(data);
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
