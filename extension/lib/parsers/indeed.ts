import type { JobLead, SiteParser } from '../types';

// Fallback only — see parseList's own resolveBaseUrl() below for why the real base URL is
// derived from the page's own origin at parse time instead of this constant. Only reached if
// `document.location` is somehow unavailable (shouldn't happen in a real content-script
// context), so this exists purely so the code always has *some* well-formed URL to fall back to
// rather than needing a null-check at every call site.
export const INDEED_BASE_URL = 'https://www.indeed.com';

// 14.09 spike (spikes/indeed_list.html) confirmed indeed.com/jobs list pages render every job's
// real data server-side inside <script id="mosaic-data">, as
// window.mosaic.providerData['mosaic-provider-jobcards'].metaData.mosaicProviderJobCardsModel
// .results — NOT the visible DOM. Two reasons this parser reads that script's raw text instead
// of the DOM, same as WellfoundListParser's extractLiveStartAt reads Wellfound's __NEXT_DATA__
// script tag rather than the page's hydrated DOM (see wellfound.ts):
//   1. The page renders TWO inconsistent card layouts for the same result set (confirmed live:
//      16/45 `div.job_seen_beacon`, 29/45 `div.jobcard-compact`, different markup/testids for
//      company/location in each) — a DOM parser would need to handle both shapes.
//   2. Salary is NEVER rendered in the DOM for the job_seen_beacon layout (confirmed: 0/16 of
//      those cards show salary text) even when the job has one — only the JSON model has it
//      reliably (37/45 jobs had extractedSalary).
// Bonus: the DOM also contains at least one invisible template anchor carrying a dummy data-jk
// not present in this JSON model at all (confirmed live, offsetWidth/offsetHeight both 0) — a
// DOM-based parser would need to explicitly filter it out; reading only the JSON model sidesteps
// that edge case entirely since the dummy entry never appears here.
//
// UNVERIFIED ASSUMPTION (flagged per DI-2966 pagination task): the exact regex/bracket-matching
// below to locate and extract the `mosaicProviderJobCardsModel` object out of the raw script
// text was written from the spike's *live-evaluated* window.mosaic... value (read via a
// javascript_tool executed in the page's own JS world), not from inspecting the script tag's
// raw serialized text byte-for-byte — content-safety tooling in that spike session blocked
// returning large raw slices of that particular script's text. It is very likely the object is
// serialized as plain JSON (these frameworks typically JSON.stringify their hydration data), and
// the marker string '"mosaicProviderJobCardsModel"' should appear verbatim since that's the
// real key name confirmed at runtime — but this has NOT been confirmed against the actual raw
// characters live. If parseList starts throwing "could not extract" errors in real use, this is
// the first thing to check (log document.getElementById('mosaic-data').textContent and inspect
// it directly).
const MOSAIC_DATA_SCRIPT_ID = 'mosaic-data';
const MODEL_KEY_MARKER = '"mosaicProviderJobCardsModel"';

// Finds the balanced `{...}` object starting at `startIndex` (which must point at the opening
// brace), respecting string literals (both quote styles, with backslash-escaping) so a brace
// character inside a job description or title can't miscount the nesting depth. Returns null if
// the text ends before the braces balance out (malformed/truncated input).
//
// Exported (24.09 follow-up) so indeed-detail-extract.ts can reuse it for the detail page's
// embedded `preloadedVJData` object — same "read a <script> tag's raw text, not window.X"
// technique, same need to safely pull one balanced object out of a much larger script without
// assuming the whole thing is valid JSON.
export function extractBalancedJson(text: string, startIndex: number): string | null {
  if (text[startIndex] !== '{') return null;
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

// Throws (never returns null) on any structural extraction failure — a missing script tag,
// unbalanced braces, or invalid JSON all mean "this page's structure isn't what we expect," which
// must NOT be confused with "this page legitimately has zero job results." (A missing job-cards
// marker inside an otherwise present #mosaic-data is the one exception — see below.)
// That distinction matters a lot to callers doing multi-page pagination (indeed-pagination.ts):
// a genuinely empty `results` array is the normal "no more pages" signal, but a parsing failure
// must instead be treated as a real error (counts toward a circuit breaker, gets surfaced to the
// manager) — collapsing the two into the same "return []" would make pagination silently stop
// early the moment this extraction logic ever breaks against a live site change.
function extractMosaicJobcardsResults(document: Document): unknown[] {
  const scriptText = document.getElementById(MOSAIC_DATA_SCRIPT_ID)?.textContent;
  if (!scriptText) {
    throw new Error(`Indeed list page: #${MOSAIC_DATA_SCRIPT_ID} script tag not found — page structure may have changed.`);
  }

  const markerIndex = scriptText.indexOf(MODEL_KEY_MARKER);
  if (markerIndex === -1) {
    // #mosaic-data present but with no job-cards model at all: a results page with nothing to
    // list (live 06.10, om.indeed.com in a multi-region run). Treated as zero results rather than
    // a structure error — content.ts flags it (hasIndeedJobList) so the page log shows it, which
    // keeps a real site-wide structure change visible without failing every empty country.
    return [];
  }

  const colonIndex = scriptText.indexOf(':', markerIndex + MODEL_KEY_MARKER.length);
  const braceIndex = colonIndex === -1 ? -1 : scriptText.indexOf('{', colonIndex);
  if (braceIndex === -1) {
    throw new Error('Indeed list page: could not locate the mosaicProviderJobCardsModel object body.');
  }

  const jsonText = extractBalancedJson(scriptText, braceIndex);
  if (!jsonText) {
    throw new Error('Indeed list page: could not extract a balanced JSON object for mosaicProviderJobCardsModel.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Indeed list page: failed to parse mosaicProviderJobCardsModel JSON — ${err instanceof Error ? err.message : String(err)}`);
  }

  const results = (parsed as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    throw new Error('Indeed list page: mosaicProviderJobCardsModel.results is missing or not an array.');
  }
  return results;
}

interface ExtractedSalary {
  min?: unknown;
  max?: unknown;
  type?: unknown;
}

function isExtractedSalary(value: unknown): value is ExtractedSalary {
  return !!value && typeof value === 'object';
}

// 0 shows up as a real value for `min` when only a max was actually posted (confirmed live,
// e.g. {min:0, max:75000}) — a $0 minimum is never a real figure, so it's treated the same as
// "not present" rather than rendered as "0-75000".
function formatSalary(salary: unknown): string {
  if (!isExtractedSalary(salary)) return '';
  const parts: string[] = [];
  if (typeof salary.min === 'number' && salary.min > 0) parts.push(String(salary.min));
  if (typeof salary.max === 'number' && salary.max > 0) parts.push(String(salary.max));
  if (parts.length === 0) return '';
  const range = parts.join('-');
  return typeof salary.type === 'string' && salary.type ? `${range} ${salary.type}` : range;
}

function toIsoOrNull(epochMs: unknown): string | null {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Latest of the model's two date fields — the posting's most recent (re)publication. See
// IndeedListParser's doc comment for why neither field alone can be trusted.
function latestIsoOrNull(...epochs: unknown[]): string | null {
  const valid = epochs.filter((e): e is number => typeof e === 'number' && Number.isFinite(e));
  return valid.length ? toIsoOrNull(Math.max(...valid)) : null;
}

// Indeed's own "next page" link on a results page. Confirmed live 02.10: with the "Date posted"
// filter (`fromage`) applied, a hand-built `&start=10` URL re-served page 1 while the site's own
// page 2 showed different postings — so pagination follows the link Indeed itself renders
// instead of constructing the URL. UNVERIFIED selectors (no pagination markup in the spike):
// several candidates, first match wins; indeed-pagination.ts logs whether a link was found or
// it fell back to `start=N`, so a miss is visible in the page log rather than silent.
const NEXT_PAGE_SELECTORS = [
  'a[data-testid="pagination-page-next"]',
  'nav[aria-label="pagination" i] a[aria-label="Next Page" i]',
  'nav[aria-label="pagination" i] a[aria-label="Next" i]',
  'a[aria-label="Next Page" i]',
];

// Total result count Indeed itself reports for the current search (`"totalJobCount":N` inside
// #mosaic-data — confirmed live 02.10: 14 for a fromage=7 search whose pagination nav was empty).
// Lets a pagination run check "scanned M of N" instead of inferring the end from page contents.
export function findIndeedTotalJobCount(document: Document): number | null {
  const text = document.getElementById(MOSAIC_DATA_SCRIPT_ID)?.textContent ?? '';
  const match = text.match(/"totalJobCount"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

// False when the page's #mosaic-data has no job-cards model (see extractMosaicJobcardsResults).
export function hasIndeedJobList(document: Document): boolean {
  return (document.getElementById(MOSAIC_DATA_SCRIPT_ID)?.textContent ?? '').includes(MODEL_KEY_MARKER);
}

export function findIndeedNextPageUrl(document: Document): string | null {
  for (const selector of NEXT_PAGE_SELECTORS) {
    const href = document.querySelector<HTMLAnchorElement>(selector)?.getAttribute('href');
    if (!href) continue;
    try {
      return new URL(href, document.location?.origin || INDEED_BASE_URL).toString();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * List parser for Indeed (indeed.com) — DI-2966, Priority #1 job source after Wellfound
 * (11.09 team call). See this file's header comment for why this reads the `mosaic-data` JSON
 * model instead of the DOM.
 *
 * `published_at` is the LATER of the model's `createDate` and `pubDate` — the posting's most
 * recent (re)publication, which is what the manager treats as "actual" (02.10 decision: a repost
 * means the company is still hiring). Neither field alone is reliable: in the 14.09 spike one
 * job's `pubDate` was ~3.8 years stale while `createDate` matched the visible "30+ days ago"; in
 * a 01.10 live ca.indeed.com sort=date run the opposite held — every `createDate` on page 1 was
 * months/years old (2024-11…2026-07) while Indeed itself sorted those postings as newest, so the
 * date-range filter rejected all of them. Both raw values stay in `snapshot` for debugging.
 *
 * `external_job_id`/dedup key is the model's `jobkey` (same 16-char hex value as the DOM's
 * `data-jk` attribute, confirmed live). `source_url` is built as the canonical
 * `<page's own origin>/viewjob?jk=<jobkey>` — deliberately NOT the DOM anchor's `href`, which
 * is a `/rc/clk?jk=...&bb=...&xkcb=...&fccid=...` click-tracking redirect, not a stable URL (and
 * irrelevant here anyway since this parser never reads the DOM at all).
 *
 * BUG FIX (23.09 follow-up): this used to hardcode INDEED_BASE_URL (https://www.indeed.com)
 * for every source_url, regardless of which Indeed locale the page actually was — confirmed as
 * the root cause of "Enrich"/auto-deepen silently never filling in descriptions for leads parsed
 * from ua.indeed.com (and, by the same reasoning, any other non-www locale: ca.indeed.com,
 * bare indeed.com, etc. — see backend.ts/content.ts/wxt.config.ts for the full locale list).
 * A ua.indeed.com jobkey has no reason to exist on www.indeed.com (they're different regional
 * job listings, not mirrors of each other) — FetchDeepening's fetch(source_url) would either hit
 * an unrelated/expired-looking page or a real 404, and parseTechjobsDetail would correctly find
 * no matching JobPosting JSON-LD there either way, so deepenOne always returned null: a lead
 * that "successfully" parsed and saved, then silently never got a description, with no error
 * anywhere in the chain because every layer along the way (deepenOne returning null, deepenLeads'
 * per-lead try/catch, FetchDeepening's plain fetch) is designed to fail soft on an ordinary
 * "page has no JobPosting data" outcome — indistinguishable, by design, from hitting the wrong
 * origin entirely. Fixed by deriving the base URL from the page's own origin
 * (document.location.origin) at parse time instead of a fixed constant — this is exactly what
 * the "Parse current list page" and auto-pagination flows are already doing (parsing whatever
 * page is actually open), so the fix is just not throwing that information away when building
 * source_url.
 */
export class IndeedListParser implements SiteParser {
  parseList(document: Document): JobLead[] {
    const scraped_at = new Date().toISOString();
    const records = extractMosaicJobcardsResults(document);
    // The page's own origin (e.g. https://ua.indeed.com) — see this class's doc comment above
    // for why this must NOT be the hardcoded INDEED_BASE_URL. document.location is always
    // present for a real page load; the fallback only guards a pathological case (e.g. this
    // parser being invoked against a detached/synthetic Document in a future test).
    const baseUrl = document.location?.origin || INDEED_BASE_URL;

    const leads: JobLead[] = [];
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const r = record as Record<string, unknown>;

      const jobkey = typeof r.jobkey === 'string' ? r.jobkey : '';
      if (!jobkey) continue; // no dedup key — skip rather than save garbage (same convention as techjobs.ts)

      leads.push({
        source_site: 'indeed',
        source_url: `${baseUrl}/viewjob?jk=${jobkey}`,
        external_job_id: jobkey,
        job_title: typeof r.displayTitle === 'string' ? r.displayTitle : '',
        company: typeof r.company === 'string' ? r.company : '',
        location: typeof r.formattedLocation === 'string' ? r.formattedLocation : '',
        salary: formatSalary(r.extractedSalary),
        scraped_at,
        published_at: latestIsoOrNull(r.createDate, r.pubDate),
        snapshot: {
          jobTypes: Array.isArray(r.jobTypes) ? r.jobTypes : [],
          expired: r.expired === true,
          remoteWorkModel: r.remoteWorkModel ?? null,
          formattedRelativeTime: typeof r.formattedRelativeTime === 'string' ? r.formattedRelativeTime : undefined,
          // Raw inputs to published_at (the later of the two) — see this class's doc comment.
          createDate: toIsoOrNull(r.createDate),
          pubDate: toIsoOrNull(r.pubDate),
        },
      });
    }
    return leads;
  }
}
