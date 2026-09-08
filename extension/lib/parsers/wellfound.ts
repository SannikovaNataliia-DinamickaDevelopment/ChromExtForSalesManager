import type { JobLead, SiteParser } from '../types';

const BASE_URL = 'https://wellfound.com';
// Every job card has exactly one Apply button (verified 1:1 against job-link count on the
// spike list page) — a much more stable landmark than Wellfound's Tailwind utility classes,
// which vary in ways that make "the job row" hard to pin down by class alone.
const APPLY_BUTTON_SELECTOR = '[data-test="JobApplicationApplyButton"]';
const COMPANY_HEADER_SELECTOR = '[data-testid="startup-header"]';
const INFO_SPAN_SELECTOR = 'span.text-xs.pl-1';
const RELATIVE_POSTED_SELECTOR = 'span.text-xs.lowercase.text-dark-a';

const JOB_ID_RE = /^\/jobs\/(\d+)-/;

// The location span sometimes nests a "+N more locations" badge as a child <span> — plain
// .textContent would pull that count in too (e.g. "Remote only • Atlanta+70"). This only
// joins the element's own direct text nodes, so the nested badge's text is excluded.
function directText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent ?? '')
    .join('')
    .trim();
}

// Walks up from the title link until it finds an ancestor that contains an Apply button —
// that's "the job row" holding salary/location/relative-posted-time. Bounded so a markup
// change can't walk all the way to <body> and start matching unrelated siblings.
function findJobRow(titleLink: Element): Element | null {
  let el: Element | null = titleLink.parentElement;
  for (let i = 0; i < 8 && el; i++) {
    if (el.querySelector(APPLY_BUTTON_SELECTOR)) return el;
    el = el.parentElement;
  }
  return titleLink.parentElement;
}

// __NEXT_DATA__ (confirmed live, 08.09 follow-up) — Wellfound's list page is Next.js, and every
// page embeds the full Apollo GraphQL cache used to render it in
// `<script id="__NEXT_DATA__" type="application/json">`. Unlike the visible relative-posted-time
// spans (RELATIVE_POSTED_SELECTOR), this script tag is injected server-side as part of the
// initial HTML response, not populated by client-side hydration — so reading it needs no
// hydration wait in principle, unlike PAGE_SETTLE_DELAY_MS (wellfound-pagination.ts). In
// practice this parser still runs after that same delay regardless, since job_title/company/
// location/salary/posted_relative are all still scraped from the hydrated DOM and still need
// it — see this file's own report on that question, not something this change alters.
//
// Each job card's entry is keyed 'JobListingSearchResult:<external_job_id>' in
// props.pageProps.apolloState.data, with a liveStartAt Unix-seconds field — confirmed live
// against a real search page (37/37 job listings present) and cross-checked byte-identical to
// that same job's detail-page JSON-LD datePosted for one specific job (id 3921291,
// 2026-08-31T16:30:45Z).
//
// Never throws — a missing script tag, malformed JSON, a missing key, or a non-numeric
// liveStartAt are all "couldn't get a precise date," same fail-to-null contract as every other
// best-effort extraction in this codebase (e.g. company-linkedin.service.ts's own
// extractLinkedinUrls) — the caller (runWellfoundAutoPagination) falls back to the existing
// relative-time approximation when this returns null, same fail-open behavior as today.
export function extractLiveStartAt(document: Document, externalJobId: string): string | null {
  try {
    const script = document.getElementById('__NEXT_DATA__');
    if (!script?.textContent) return null;

    const data = JSON.parse(script.textContent) as {
      props?: { pageProps?: { apolloState?: { data?: Record<string, unknown> } } };
    };
    const apolloData = data.props?.pageProps?.apolloState?.data;
    if (!apolloData) return null;

    const entry = apolloData[`JobListingSearchResult:${externalJobId}`] as { liveStartAt?: unknown } | undefined;
    const liveStartAt = entry?.liveStartAt;
    if (typeof liveStartAt !== 'number' || !Number.isFinite(liveStartAt)) return null;

    return new Date(liveStartAt * 1000).toISOString();
  } catch {
    return null;
  }
}

/**
 * List parser for Wellfound (wellfound.com) — CLAUDE.md "Parser spec". Cards are NOT
 * self-contained like Techjobs/ITjobs: the page groups job rows under a preceding company
 * section (`[data-testid="startup-header"]`), so company name is attached by scanning the
 * page once in document order and remembering the most recent company header seen.
 *
 * Wellfound's list only shows a RELATIVE posted time in its visible DOM ("4 days ago",
 * "yesterday", "5 months ago" — no absolute date), unlike Techjobs' "Posted M/D/YYYY" — still
 * captured as `snapshot.posted_relative` below, used only as runWellfoundAutoPagination's
 * fallback range-filter signal (wellfound-relative-date.ts) when the precise extraction below
 * fails. `published_at` itself now comes from extractLiveStartAt (this file, above) — the
 * page's own __NEXT_DATA__ Apollo cache, present in the initial server-rendered HTML — and only
 * falls back to null (backfilled from the detail page's JSON-LD `datePosted` during deepening,
 * same mechanism already used when a Techjobs card's date couldn't be parsed) on the rare
 * extraction failure.
 */
export class WellfoundListParser implements SiteParser {
  parseList(document: Document): JobLead[] {
    const scraped_at = new Date().toISOString();
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(`${COMPANY_HEADER_SELECTOR}, a[href^="/jobs/"]`),
    );

    let currentCompany = '';
    const leads: JobLead[] = [];

    for (const node of nodes) {
      if (node.matches(COMPANY_HEADER_SELECTOR)) {
        currentCompany = node.querySelector('h2')?.textContent?.trim() ?? '';
        continue;
      }

      const href = node.getAttribute('href') ?? '';
      const idMatch = JOB_ID_RE.exec(href);
      const external_job_id = idMatch?.[1] ?? href.split('/').filter(Boolean).pop() ?? '';
      const source_url = `${BASE_URL}${href}`;
      const job_title = node.textContent?.trim() ?? '';
      const employment_type = node.nextElementSibling?.textContent?.trim();

      const jobRow = findJobRow(node);
      const infoSpans = jobRow ? Array.from(jobRow.querySelectorAll(INFO_SPAN_SELECTOR)) : [];
      const texts = infoSpans.map(directText).filter((t) => !!t);
      const salary = texts.find((t) => t.startsWith('$'));
      const location = texts.find((t) => !t.startsWith('$'));
      const posted_relative = jobRow?.querySelector(RELATIVE_POSTED_SELECTOR)?.textContent?.trim();
      const published_at = extractLiveStartAt(document, external_job_id);

      const lead: JobLead = {
        source_site: 'wellfound',
        source_url,
        external_job_id,
        job_title,
        company: currentCompany,
        location: location ?? '',
        salary: salary ?? '',
        scraped_at,
        published_at,
        snapshot: { employment_type, posted_relative },
      };
      leads.push(lead);
    }

    return leads;
  }
}
