import { AuthError, saveLeads, type LeadSaveResult } from './api';
import {
  IndeedBackgroundWindow,
  IndeedBackgroundWindowClosedError,
  pacedDelay,
  passHumanCheckIfShown,
} from './indeed-background-window';
import { formatDateInZone } from './indeed-regions';
import { isWithinRange } from './wellfound-relative-date';
import type { JobLead } from './types';

// DI-2966, Priority #1 (11.09 call): Indeed's own list-page pagination — deliberately separate
// from wellfound-pagination.ts, same reasoning as that file staying separate from multipage.ts.
// Three concrete, confirmed differences from Wellfound that make sharing code the wrong call:
//   1. URL scheme: Wellfound uses `?page=N` (a page number); Indeed uses `&start=N` (a result
//      OFFSET). See INDEED_START_INCREMENT below for what's actually confirmed about the step
//      size, and what isn't.
//   2. A real, confirmed sign-in wall on page 2+ ("create an account or sign in", redirects to
//      secure.indeed.com) that Wellfound does not have. See isIndeedSignInWall.
//   3. Indeed's tolerance for automated sequential navigation is completely UNVERIFIED — the
//      14.09 spike only tested one manual click. See the pacing constants below: conservative,
//      named, easy to raise, NOT copied from Wellfound's own (separately tuned) values.

// UNVERIFIED (flagged per the DI-2966 task): confirmed live exactly once, manually, that
// requesting page 2 of one specific query used `&start=10` — i.e. an offset that increases by
// 10 per page, implying 10 results per page. NOT re-confirmed across other queries/locations, and
// notably the *first* page's own JSON model (spikes/indeed_list.html) contained 45 entries, not
// 10 — an unresolved mismatch between "how many jobs page 1's own JSON shows" and "how big a
// pagination step is." Before trusting this for real multi-page walking, re-verify live: does
// every query use a 10-result step, and does page 1's larger count mean something different is
// going on there (e.g. extra "related searches" content bundled into the same JSON model)?
export const INDEED_START_INCREMENT = 10;

// Conservative, Indeed-specific starting guess — NOT copied from Wellfound's MIN/MAX_TAB_DELAY_MS
// (wellfound-deepen.ts), which were tuned against Wellfound specifically through real use.
// Indeed's own tolerance for automated sequential page navigation has never been tested beyond
// one manual click (14.09 spike). Start slower than Wellfound's 4-8s and only relax this once
// a real run confirms it's safe. Named + easy to raise, same convention as every Wellfound
// pacing constant.
export const MIN_INDEED_TAB_DELAY_MS = 5000;
export const MAX_INDEED_TAB_DELAY_MS = 10000;

// Batched by PAGES (not postings, unlike Wellfound's WELLFOUND_AUTO_BATCH_POSTINGS) — simpler,
// and appropriate given how little is confirmed about Indeed's own per-page result count (see
// INDEED_START_INCREMENT above). Untested starting guess, same as the delay constants above.
export const INDEED_AUTO_BATCH_PAGES = 5;
export const INDEED_AUTO_BATCH_PAUSE_MIN_MS = 30_000;
export const INDEED_AUTO_BATCH_PAUSE_MAX_MS = 60_000;

// Pure runaway-loop safety net, same role as WELLFOUND_AUTO_PAGINATION_MAX_PAGES. In practice,
// given the confirmed sign-in wall on page 2+, a run against a not-yet-signed-in Chrome profile
// will almost always stop at 'indeed_signin_required' long before this could ever matter.
export const INDEED_AUTO_PAGINATION_MAX_PAGES = 500;

// Indeed-specific — deliberately not imported from wellfound-deepen.ts's
// WELLFOUND_CIRCUIT_BREAKER_THRESHOLD (that constant is exported from a Wellfound-named module
// for Wellfound's own use; Indeed gets its own copy so the two can be tuned independently, same
// "no shared/borrowed tunables across sites" stance as the pacing constants above). Same value
// as Wellfound's today (3) purely because there's no evidence yet to pick a different number —
// not a claim that Indeed's actual tolerance matches Wellfound's.
export const INDEED_CIRCUIT_BREAKER_THRESHOLD = 3;

// Anti-loop guard (02.10): Indeed doesn't return an empty page past the end — it re-serves the
// last page, possibly with a rotating sponsored posting or two mixed in. A page that adds at most
// this many postings not seen earlier in the run counts as "nothing new"; this many such pages in
// a row ends the run. Complements the exact "zero unseen" check and the missing-next-link check.
const INDEED_LOW_NOVELTY_MAX_UNSEEN = 2;
const INDEED_LOW_NOVELTY_PAGES_TO_STOP = 2;

// After chrome.tabs.onUpdated reports the navigation "complete", give the content script's own
// onMessage listener a moment to actually attach before messaging it (same race
// wellfound-background-window.ts's showOverlayWithRetry documents, and the reason
// multipage.ts/wellfound-pagination.ts each carry their own settle delay before their first
// PARSE_LIST send). UNVERIFIED starting guess, shorter than Wellfound's 3000ms/Techjobs' 3000ms:
// those two both wait out real client-side hydration/rendering before their job data even
// exists, but Indeed's mosaic-data script is confirmed present in the *initial* server-rendered
// HTML (no hydration wait needed for the data itself) — so this delay's only real job here is
// the content-script-listener race, not waiting for content to render. If PARSE_LIST calls start
// failing intermittently in real use, raise this first before suspecting anything else.
const INDEED_PAGE_SETTLE_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-view/click-tracking params Indeed adds to the address bar that must NOT be carried into
// paginated list URLs. Confirmed live 01.10 (page log): with `vjk=<jobkey>` (the job selected in
// the right-hand preview pane) present, every `&start=N>0` request redirected to that job's own
// /viewjob page instead of results page N — no #mosaic-data there, so pages 2+ all failed and the
// run tripped the circuit breaker. `advn`/`tk` are the same kind of per-view tracking state.
const INDEED_EPHEMERAL_PARAMS = ['vjk', 'advn', 'tk'];

function stripEphemeralParams(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const param of INDEED_EPHEMERAL_PARAMS) url.searchParams.delete(param);
  return url.toString();
}

// Fallback page URL (`&start=N`) — used for page 1 and only when the previous page rendered no
// "next page" link of Indeed's own (see findIndeedNextPageUrl, parsers/indeed.ts).
function buildPageUrl(baseUrl: string, start: number): string {
  const url = new URL(stripEphemeralParams(baseUrl));
  url.searchParams.set('start', String(start));
  return url.toString();
}

// Indeed's own "Date posted" filter (`fromage` = max age in days) only accepts these buckets.
const INDEED_FROMAGE_BUCKETS = [1, 3, 7, 14];
const DAY_MS = 24 * 60 * 60 * 1000;

// Confirmed live 01.10 (page log): `sort=date` does NOT give a chronological list — pages mixed
// "30+ days ago" / "10 days ago" / "7 days ago" postings throughout (sponsored/relevance-ranked
// results interleaved), so a narrow date range would only be reached after walking a large part
// of the whole result set. Instead, narrow the search server-side with `fromage`: the smallest
// bucket that still covers range.start (+1 day slack for the Kyiv vs. the region's own timezone
// difference); the exact range check (isWithinRange) still applies on top. A range older than
// the largest bucket can't be expressed — `fromage` is removed then (including one the manager
// set manually, which would otherwise silently cut the range short), and the run walks the full
// result set as before.
function applyDateRangeFilter(baseUrl: string, rangeStart: string, timeZone: string): string {
  const url = new URL(baseUrl);
  const today = formatDateInZone(new Date().toISOString(), timeZone);
  const daysBack = Math.round((Date.parse(today) - Date.parse(rangeStart)) / DAY_MS) + 1;
  const bucket = INDEED_FROMAGE_BUCKETS.find((b) => b >= daysBack);
  if (bucket) url.searchParams.set('fromage', String(bucket));
  else url.searchParams.delete('fromage');
  return url.toString();
}

// A results page lives under /jobs (or Indeed's SEO /q-...-jobs.html form); landing on /viewjob
// means Indeed redirected away from the results list (see INDEED_EPHEMERAL_PARAMS).
function isIndeedJobDetailUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.startsWith('/viewjob');
  } catch {
    return false;
  }
}

// Confirmed live (11.09 context): Indeed's sign-in wall on page 2+ redirects the tab to
// secure.indeed.com. Checking the hostname (not a specific path) is deliberate — ANY page on
// that host is an account/sign-in flow, and the content script's manifest matches only
// www.indeed.com, so no path guessing is needed or possible here. This is the one sign-in-wall
// signal this file actually trusts; anything path-based on www.indeed.com itself would be an
// unverified guess and is deliberately NOT checked.
function isIndeedSignInWall(url: string | null): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === 'secure.indeed.com';
  } catch {
    return false;
  }
}

interface ParseListResponse {
  ok: boolean;
  leads?: unknown;
  nextPageUrl?: unknown;
  totalJobCount?: unknown;
  error?: string;
}

interface LoadPageResult {
  signInRequired: boolean;
  leads: JobLead[];
  finalUrl: string | null;
  // Indeed's own "next page" link on this page, if one was found (see findIndeedNextPageUrl).
  nextPageUrl: string | null;
  // Total results Indeed reports for this search (see findIndeedTotalJobCount), null if not found.
  totalJobCount: number | null;
}

// Thin wrapper around IndeedBackgroundWindow, mirroring wellfound-pagination.ts's
// BackgroundListTab shape — keeps the "navigate, settle, check sign-in wall, PARSE_LIST" sequence
// in one place. Exported so a multi-region run (indeed-multi-region.ts) can reuse ONE window across
// every region instead of opening a new focused popup per region.
export class IndeedBackgroundListTab {
  private readonly win = new IndeedBackgroundWindow('indeed-pagination');

  // Navigates to the given list page URL. If the tab lands on the sign-in wall
  // (isIndeedSignInWall), returns immediately with signInRequired: true WITHOUT attempting
  // PARSE_LIST — the content script isn't injected on secure.indeed.com at all, so sending
  // PARSE_LIST there would just throw a generic "no receiving end" error instead of the clear,
  // distinct signal callers need. Throws IndeedBackgroundWindowClosedError if the background
  // window is gone.
  async loadPage(url: string): Promise<LoadPageResult> {
    await this.win.navigate(url);
    await sleep(INDEED_PAGE_SETTLE_DELAY_MS);

    const finalUrl = await this.win.getTabUrl();
    if (isIndeedSignInWall(finalUrl)) {
      return { signInRequired: true, leads: [], finalUrl, nextPageUrl: null, totalJobCount: null };
    }
    if (isIndeedJobDetailUrl(finalUrl)) {
      throw new Error('Indeed redirected to a single job page instead of the results list.');
    }
    // Cloudflare check instead of results: pause until the manager ticks it in the raised window
    // (never solved automatically), then read the page it reloads into.
    if (!(await passHumanCheckIfShown(this.win))) {
      throw new Error('Bot check (Cloudflare) was not completed within 3 minutes.');
    }

    const res = await this.win.sendMessage<ParseListResponse>({ type: 'PARSE_LIST' });
    if (!res?.ok || !Array.isArray(res.leads)) {
      throw new Error(res?.error ?? 'Could not parse this page.');
    }

    const nextPageUrl = typeof res.nextPageUrl === 'string' && res.nextPageUrl ? stripEphemeralParams(res.nextPageUrl) : null;
    const totalJobCount = typeof res.totalJobCount === 'number' ? res.totalJobCount : null;
    return { signInRequired: false, leads: res.leads as JobLead[], finalUrl, nextPageUrl, totalJobCount };
  }

  get wasClosedByUser(): boolean {
    return this.win.wasClosedByUser;
  }

  // For the diagnostic page log when loadPage itself threw (no LoadPageResult to read finalUrl from).
  getTabUrl(): Promise<string | null> {
    return this.win.getTabUrl();
  }

  pacedDelay(minMs: number, maxMs: number): Promise<boolean> {
    return pacedDelay(this.win, minMs, maxMs);
  }

  setProgress(text: string): void {
    this.win.setProgress(text);
  }

  refreshOverlay(): Promise<void> {
    return this.win.refreshOverlay();
  }

  async close(): Promise<void> {
    await this.win.close();
  }
}

export interface IndeedAutoPaginationProgress {
  page: number; // 1-based display page number (start = (page-1) * INDEED_START_INCREMENT)
  // Unique jobkeys seen this run (25.09 fix) — a posting repeated across overlapping pages or a
  // re-served last page is counted once, so scanned = saved + alreadyKnown + skippedOutOfRange.
  postingsScanned: number;
  postingsSaved: number;
  // In-range postings that already existed in the DB (a dedup update, not a new lead).
  postingsAlreadyKnown: number;
  // 24.09 follow-up (date-range filter): in-range-vs-out-of-range, same "actually skipped, not
  // just hidden" semantics as Wellfound's own postingsSkippedOutOfRange — see
  // runIndeedAutoPagination's doc comment.
  postingsSkippedOutOfRange: number;
  phase: 'scanning' | 'batch_pause';
}

export type IndeedAutoPaginationStopReason =
  | 'no_more_pages'
  | 'circuit_breaker'
  | 'window_closed'
  | 'auth_error'
  | 'indeed_signin_required'
  | 'max_pages';

// Diagnostic per-page record (01.10 follow-up): a live ca.indeed.com run stopped right after
// page 1 with no way to tell why — pagination only kept aggregate counters, so the stop cause
// (sign-in wall, a re-served/duplicate page, an empty page, a parse error) had to be guessed from
// DB timestamps. One entry per page attempt, logged to the side panel's console as it happens and
// returned with the result so the panel can show it too.
export interface IndeedPageLogEntry {
  page: number;
  start: number;
  requestedUrl: string;
  // How requestedUrl was obtained: page 1's own URL, the previous page's "next page" link, or the
  // `&start=N` fallback (previous page had no link, or failed). 'start_fallback' after page 1
  // means the next-link selectors didn't match — see findIndeedNextPageUrl.
  urlSource: 'first' | 'next_link' | 'start_fallback';
  // This page's own "next page" link (null = none rendered/found).
  nextPageUrl: string | null;
  // Tab URL after navigation settled — differs from requestedUrl on any redirect (sign-in wall,
  // Indeed dropping/rewriting `start`, a challenge page).
  finalUrl: string | null;
  outcome: 'parsed' | 'signin_wall' | 'error';
  error?: string;
  // Raw postings on the page, then how many weren't seen earlier in this run, then the in/out
  // of date-range split of those unseen ones. Zero for non-'parsed' outcomes.
  postings: number;
  unseen: number;
  inRange: number;
  outOfRange: number;
  // Of the in-range ones: newly inserted vs. already in the DB (dedup update).
  saved: number;
  alreadyKnown: number;
  // Date span (YYYY-MM-DD, in the run's time zone) of every posting on the page — shows at a glance whether a
  // sort=date page is newer/older than the picked range, or identical to the previous page.
  newestDate: string | null;
  oldestDate: string | null;
  // First few postings as Indeed itself describes them — the visible relative time next to both
  // date fields of the model — to check which field actually matches what the page shows/sorts
  // by (01.10: a sort=date run had every createDate months/years old, see parsers/indeed.ts).
  sample: string[];
  // Set only on the entry that ended the run (or on the last entry, for loop-exit stops).
  stopReason?: IndeedAutoPaginationStopReason;
}

const PAGE_LOG_SAMPLE_SIZE = 3;

function postingSample(leads: JobLead[], timeZone: string): string[] {
  return leads.slice(0, PAGE_LOG_SAMPLE_SIZE).map((l) => {
    const snap = (l.snapshot ?? {}) as { formattedRelativeTime?: unknown; createDate?: unknown; pubDate?: unknown };
    const rel = typeof snap.formattedRelativeTime === 'string' ? snap.formattedRelativeTime : '?';
    const raw = (v: unknown) => (typeof v === 'string' ? formatDateInZone(v, timeZone) : '') || '-';
    return (
      `"${(l.job_title ?? '').slice(0, 30)}" shown "${rel}" → used ${formatDateInZone(l.published_at, timeZone) || '-'} ` +
      `(createDate ${raw(snap.createDate)}, pubDate ${raw(snap.pubDate)})`
    );
  });
}

function dateSpan(leads: JobLead[], timeZone: string): { newestDate: string | null; oldestDate: string | null } {
  const dates = leads.map((l) => formatDateInZone(l.published_at, timeZone)).filter(Boolean).sort();
  return { newestDate: dates[dates.length - 1] ?? null, oldestDate: dates[0] ?? null };
}

export function formatIndeedPageLogEntry(e: IndeedPageLogEntry): string {
  // Page 1 also shows the exact URL requested, so the search params actually used (q, l, sort,
  // fromage…) are visible in the log without opening the console.
  const via = e.urlSource === 'next_link' ? 'via next link' : e.urlSource === 'start_fallback' ? `via start=${e.start}` : 'first';
  const head = e.page === 1 ? `p1 (${e.requestedUrl})` : `p${e.page} (${via})`;
  const next = e.outcome === 'parsed' ? (e.nextPageUrl ? ', next link: yes' : ', next link: NONE') : '';
  const redirect = e.finalUrl && e.finalUrl !== e.requestedUrl ? ` → ${e.finalUrl}` : '';
  const stop = e.stopReason ? ` ■ STOP: ${e.stopReason}` : '';
  if (e.outcome === 'signin_wall') return `${head}: sign-in wall${redirect}${stop}`;
  if (e.outcome === 'error') return `${head}: ERROR ${e.error ?? ''}${redirect}${stop}`;
  const span = e.newestDate ? ` [${e.oldestDate}…${e.newestDate}]` : '';
  const sample = e.sample.length ? ` | top: ${e.sample.join('; ')}` : '';
  return (
    `${head}: ${e.postings} on page${span}, ${e.unseen} unseen, ${e.inRange} in range / ${e.outOfRange} out, ` +
    `${e.saved} new + ${e.alreadyKnown} already in DB${next}${redirect}${stop}${sample}`
  );
}

export interface IndeedAutoPaginationResult {
  pagesProcessed: number;
  postingsScanned: number;
  // Newly inserted (not a dedup update) — same semantics as Wellfound's postingsSaved.
  postingsSaved: number;
  // In-range postings that were already in the DB before this run (dedup updates).
  postingsAlreadyKnown: number;
  // 24.09 follow-up: postings discarded for falling outside the manager's picked date range —
  // never sent to saveLeads at all, not merely hidden in a later UI filter. Same field name/
  // semantics as WellfoundAutoPaginationResult's postingsSkippedOutOfRange.
  postingsSkippedOutOfRange: number;
  savedLeads: LeadSaveResult[];
  stopReason: IndeedAutoPaginationStopReason;
  errorMessage?: string;
  pageLog: IndeedPageLogEntry[];
  // Total results Indeed reported for the search (first page that carried it), null if never
  // found — compare with postingsScanned to confirm the run covered the whole result set.
  indeedTotalJobCount: number | null;
}

/**
 * DI-2966: fully automated Indeed multi-page parse, the Indeed equivalent of
 * wellfound-pagination.ts's runWellfoundAutoPagination. One click walks every page of the
 * current search via `&start=N` (INDEED_START_INCREMENT per page) in a dedicated background
 * window, saving only postings whose published date falls in the manager's picked range —
 * everything else is discarded on the spot, never sent to saveLeads (24.09 follow-up — this was
 * scoped out of the original build as a deferred follow-up; now added).
 *
 * Simpler than Wellfound's own range filter: Wellfound needs a two-tier precise-or-approximate
 * check because its list only exposes a relative-time approximation when the precise
 * __NEXT_DATA__ extraction fails. Indeed's `published_at` (parsers/indeed.ts's `createDate`
 * mapping) is confirmed reliable and present for essentially every posting (see that file), so
 * this only needs one direct comparison — `isWithinRange(formatDateInZone(lead.published_at, timeZone),
 * range.start, range.end)` — reusing the exact same generic comparator Wellfound's filter uses
 * (isWithinRange, wellfound-relative-date.ts — a plain date-range check despite the filename,
 * not Wellfound-specific logic). The one deliberate extra: a lead with a null `published_at`
 * (the rare case createDate was missing/unparseable for that record) fails OPEN — included
 * rather than discarded — same "never silently drop a lead we can't judge" stance
 * wellfound-relative-date.ts documents for its own unparseable-text case, just without needing a
 * second data source to fall back to first.
 *
 * "No more pages" detection deliberately does NOT copy Wellfound's "out-of-range page redirects
 * back to page 1" mechanism as its ONLY signal — the DI-2966 task is explicit that Indeed's own
 * out-of-range behavior (redirect? empty page? something else?) was never tested live. The
 * primary, robust signal used here instead is simply an empty `leads` array from a page that
 * parsed successfully (parsers/indeed.ts throws rather than returning [] on a structural parse
 * failure — see that file — specifically so a real parsing bug can never be mistaken for "no
 * more results" here). Checked on the RAW leads array, before date filtering — same reasoning as
 * Wellfound's own check — so a page whose postings are ALL out of range is never mistaken for
 * the end of the results. The tab's final URL is also read (getTabUrl) and available for a
 * future secondary check once Indeed's actual out-of-range behavior is confirmed live, but no
 * such check is applied yet since trusting an unconfirmed redirect pattern could stop a run too
 * early.
 *
 * The confirmed sign-in wall (isIndeedSignInWall) is checked before anything else on each page
 * and stops the run immediately with its own distinct reason ('indeed_signin_required'),
 * DELIBERATELY NOT counted toward the circuit breaker — hitting the sign-in wall is expected,
 * normal Indeed behavior on an anonymous session, not a sign of a bot-detection block. Per the
 * task's own framing: since this background window shares the manager's real Chrome profile and
 * cookies, this should resolve itself once they're signed into Indeed anywhere in that browser —
 * no in-extension login flow is attempted or needed.
 *
 * Pacing mirrors Wellfound's two-layer shape (per-page delay + a longer batch-pause cooldown)
 * but with Indeed-specific, untested-starting-guess constants — see this file's top for why
 * these are NOT copied from Wellfound's own tuned values.
 */
export interface IndeedAutoPaginationOptions {
  // IANA zone the picked range is evaluated in (the region's own — see indeed-regions.ts).
  // Defaults to Kyiv, the original single-domain behaviour.
  timeZone?: string;
  // Reuse a caller-owned background window (multi-region run); this function then never closes it.
  tab?: IndeedBackgroundListTab;
  // Prefix for console log lines, e.g. the region label.
  logLabel?: string;
  // Text prepended to the background window's overlay progress (multi-region status: which
  // region is running, which are done, which are queued).
  overlayPrefix?: string;
}

export async function runIndeedAutoPagination(
  baseUrl: string,
  range: { start: string; end: string },
  onProgress: (progress: IndeedAutoPaginationProgress) => void,
  options: IndeedAutoPaginationOptions = {},
): Promise<IndeedAutoPaginationResult> {
  const timeZone = options.timeZone ?? 'Europe/Kyiv';
  const ownsTab = !options.tab;
  const tab = options.tab ?? new IndeedBackgroundListTab();
  const progressPrefix = options.overlayPrefix ?? (options.logLabel ? `${options.logLabel}: ` : '');
  const logPrefix = options.logLabel ? `[Indeed pagination · ${options.logLabel}]` : '[Indeed pagination]';

  let start = 0;
  let page = 1;
  // Next page's URL from the previous page's own "next page" link; null = use `&start=N`.
  let nextLinkUrl: string | null = null;
  // Once any page has rendered a next link, a later page WITHOUT one is Indeed saying it's the
  // last page — a cleaner end signal than the re-served-page check below.
  let sawNextLink = false;
  // Every page URL requested this run — a next link pointing back to one of them is a cycle.
  const visitedUrls = new Set<string>();
  let lowNoveltyPages = 0;
  let indeedTotalJobCount: number | null = null;
  let pagesProcessed = 0;
  let postingsScanned = 0;
  let postingsSaved = 0;
  let postingsAlreadyKnown = 0;
  let postingsSkippedOutOfRange = 0;
  let pagesSinceLastPause = 0;
  // Every jobkey seen this run. 25.09 live test (ca.indeed.com): once `start` runs past the last
  // real results page, Indeed does NOT return an empty page — it re-serves the last page for
  // every further offset, so an empty-page check alone never fires and the run looped the same
  // 15 postings from page ~10 up toward INDEED_AUTO_PAGINATION_MAX_PAGES. A page with no jobkey
  // outside this set is treated as the end of the results.
  const seenJobKeys = new Set<string>();
  let consecutiveFailures = 0;
  let stopReason: IndeedAutoPaginationStopReason = 'no_more_pages';
  let errorMessage: string | undefined;
  const savedLeads: LeadSaveResult[] = [];
  const pageLog: IndeedPageLogEntry[] = [];

  const isClosedError = (err: unknown) => err instanceof IndeedBackgroundWindowClosedError || tab.wasClosedByUser;
  const emitProgress = (phase: IndeedAutoPaginationProgress['phase']) =>
    onProgress({ page, postingsScanned, postingsSaved, postingsAlreadyKnown, postingsSkippedOutOfRange, phase });
  const logPage = (entry: IndeedPageLogEntry) => {
    pageLog.push(entry);
    console.log(`${logPrefix} ${formatIndeedPageLogEntry(entry)}`, entry);
  };
  const emptyCounts = { postings: 0, unseen: 0, inRange: 0, outOfRange: 0, saved: 0, alreadyKnown: 0, newestDate: null, oldestDate: null, sample: [] };

  baseUrl = applyDateRangeFilter(baseUrl, range.start, timeZone);
  console.log(`${logPrefix} run started — base ${baseUrl}, range ${range.start}…${range.end} (${timeZone} dates)`);

  try {
    while (page <= INDEED_AUTO_PAGINATION_MAX_PAGES) {
      const urlSource: IndeedPageLogEntry['urlSource'] = page === 1 ? 'first' : nextLinkUrl ? 'next_link' : 'start_fallback';
      const pageUrl = nextLinkUrl ?? buildPageUrl(baseUrl, start);
      nextLinkUrl = null;
      visitedUrls.add(pageUrl);

      let signInRequired: boolean;
      let leads: JobLead[];
      let finalUrl: string | null;
      let nextPageUrl: string | null;
      let totalJobCount: number | null;
      try {
        ({ signInRequired, leads, finalUrl, nextPageUrl, totalJobCount } = await tab.loadPage(pageUrl));
      } catch (err) {
        if (isClosedError(err)) {
          stopReason = 'window_closed';
          logPage({ page, start, requestedUrl: pageUrl, urlSource, nextPageUrl: null, finalUrl: null, outcome: 'error', error: 'background window closed', ...emptyCounts, stopReason });
          break;
        }
        errorMessage = err instanceof Error ? err.message : String(err);
        consecutiveFailures++;
        const entry: IndeedPageLogEntry = {
          page, start, requestedUrl: pageUrl, urlSource, nextPageUrl: null, finalUrl: await tab.getTabUrl(), outcome: 'error', error: errorMessage, ...emptyCounts,
        };
        if (consecutiveFailures >= INDEED_CIRCUIT_BREAKER_THRESHOLD) {
          stopReason = 'circuit_breaker';
          logPage({ ...entry, stopReason });
          break;
        }
        logPage(entry);
        emitProgress('scanning');
        if (await tab.pacedDelay(MIN_INDEED_TAB_DELAY_MS, MAX_INDEED_TAB_DELAY_MS)) {
          stopReason = 'window_closed';
          break;
        }
        page++;
        start += INDEED_START_INCREMENT;
        continue;
      }

      // Checked first, before anything else — expected/normal Indeed behavior on an anonymous
      // session, not a failure. Deliberately does not touch consecutiveFailures.
      if (signInRequired) {
        stopReason = 'indeed_signin_required';
        logPage({ page, start, requestedUrl: pageUrl, urlSource, nextPageUrl, finalUrl, outcome: 'signin_wall', ...emptyCounts, stopReason });
        break;
      }

      if (indeedTotalJobCount === null && totalJobCount !== null) {
        indeedTotalJobCount = totalJobCount;
        console.log(`${logPrefix} Indeed reports ${totalJobCount} result(s) for this search`);
      }

      const pageEntry: IndeedPageLogEntry = {
        page, start, requestedUrl: pageUrl, urlSource, nextPageUrl, finalUrl, outcome: 'parsed', ...emptyCounts,
        postings: leads.length, ...dateSpan(leads, timeZone), sample: postingSample(leads, timeZone),
      };

      // Primary "no more pages" signal — see this function's doc comment for why an empty
      // array (from a page that parsed successfully, i.e. didn't throw) is trusted here rather
      // than any URL-redirect pattern, which is unconfirmed for Indeed. Checked on the RAW
      // leads array, before date filtering below, so an all-filtered-out page is never
      // mistaken for the end of the results.
      if (leads.length === 0) {
        stopReason = 'no_more_pages';
        logPage({ ...pageEntry, stopReason });
        break;
      }

      // Only postings not already seen earlier in this run — see seenJobKeys. Overlapping pages
      // (Indeed's step is 10 while a page shows ~15) also land here, so a repeat is never
      // re-saved or re-counted. Also checked before date filtering, for the same reason as the
      // empty check above.
      const newLeads = leads.filter((lead) => !seenJobKeys.has(lead.external_job_id));
      pageEntry.unseen = newLeads.length;
      if (newLeads.length === 0) {
        stopReason = 'no_more_pages';
        logPage({ ...pageEntry, stopReason });
        break;
      }
      for (const lead of newLeads) seenJobKeys.add(lead.external_job_id);

      // 24.09 follow-up (date-range filter) — see this function's doc comment for why this is a
      // single direct comparison rather than Wellfound's precise-or-approximate fallback chain.
      const inRange = newLeads.filter((lead) => {
        if (!lead.published_at) return true; // no date to judge by — fail open, never silently drop a lead
        return isWithinRange(formatDateInZone(lead.published_at, timeZone), range.start, range.end);
      });
      const outOfRangeCount = newLeads.length - inRange.length;
      pageEntry.inRange = inRange.length;
      pageEntry.outOfRange = outOfRangeCount;

      let saveResults: LeadSaveResult[] = [];
      if (inRange.length > 0) {
        try {
          saveResults = await saveLeads(inRange);
        } catch (err) {
          if (err instanceof AuthError) {
            stopReason = 'auth_error';
            errorMessage = err.message;
            logPage({ ...pageEntry, outcome: 'error', error: `backend save: ${err.message}`, stopReason });
            break;
          }
          errorMessage = err instanceof Error ? err.message : String(err);
          consecutiveFailures++;
          const errorEntry: IndeedPageLogEntry = { ...pageEntry, outcome: 'error', error: `backend save: ${errorMessage}` };
          if (consecutiveFailures >= INDEED_CIRCUIT_BREAKER_THRESHOLD) {
            stopReason = 'circuit_breaker';
            logPage({ ...errorEntry, stopReason });
            break;
          }
          logPage(errorEntry);
          emitProgress('scanning');
          if (await tab.pacedDelay(MIN_INDEED_TAB_DELAY_MS, MAX_INDEED_TAB_DELAY_MS)) {
            stopReason = 'window_closed';
            break;
          }
          page++;
          start += INDEED_START_INCREMENT;
          continue;
        }
      }

      consecutiveFailures = 0;
      pagesProcessed++;
      const savedThisPage = saveResults.filter((r) => r?.lead && !r.deduplicated).length;
      const alreadyKnownThisPage = saveResults.filter((r) => r?.lead && r.deduplicated).length;
      postingsScanned += newLeads.length;
      postingsSkippedOutOfRange += outOfRangeCount;
      postingsSaved += savedThisPage;
      postingsAlreadyKnown += alreadyKnownThisPage;
      savedLeads.push(...saveResults);
      pagesSinceLastPause++;
      // End-of-results signals, any one of which stops the run (Indeed never says "no more pages"):
      //  - it rendered a next link on an earlier page but none here;
      //  - the next link points back at a page already requested this run (a cycle);
      //  - INDEED_LOW_NOVELTY_PAGES_TO_STOP pages in a row added almost nothing new (a re-served
      //    last page with rotating sponsored postings — the exact "zero unseen" case is caught
      //    earlier, before saving).
      lowNoveltyPages = newLeads.length <= INDEED_LOW_NOVELTY_MAX_UNSEEN ? lowNoveltyPages + 1 : 0;
      // NOT "seen >= totalJobCount": confirmed live 02.10 (www.indeed.com) that a page's model can
      // carry extra postings beyond the search results themselves (35 on a 15-result page 1), so
      // the seen count overtook Indeed's reported total (39) on page 2 while a next link still
      // existed — that check ended the run early. totalJobCount stays informational only.
      const isLastPage =
        (sawNextLink && !nextPageUrl) ||
        (!!nextPageUrl && visitedUrls.has(nextPageUrl)) ||
        lowNoveltyPages >= INDEED_LOW_NOVELTY_PAGES_TO_STOP;
      if (nextPageUrl) sawNextLink = true;
      nextLinkUrl = nextPageUrl;
      logPage({
        ...pageEntry,
        saved: savedThisPage,
        alreadyKnown: alreadyKnownThisPage,
        ...(isLastPage ? { stopReason: 'no_more_pages' as const } : {}),
      });
      if (isLastPage) {
        stopReason = 'no_more_pages';
        emitProgress('scanning');
        break;
      }

      tab.setProgress(
        `${progressPrefix}Page ${page} scanned — ${postingsScanned} posting(s) seen, ${postingsSaved} new, ${postingsAlreadyKnown} already in DB, ` +
          `${postingsSkippedOutOfRange} out of range so far`,
      );
      emitProgress('scanning');
      page++;
      start += INDEED_START_INCREMENT;

      if (pagesSinceLastPause >= INDEED_AUTO_BATCH_PAGES) {
        pagesSinceLastPause = 0;
        tab.setProgress(
          `${progressPrefix}Batch pause (anti-bot cooldown) — resuming automatically. ${postingsScanned} posting(s) scanned so far, ${postingsSaved} new, ` +
            `${postingsAlreadyKnown} already in DB, ${postingsSkippedOutOfRange} out of range.`,
        );
        await tab.refreshOverlay();
        emitProgress('batch_pause');
        if (await tab.pacedDelay(INDEED_AUTO_BATCH_PAUSE_MIN_MS, INDEED_AUTO_BATCH_PAUSE_MAX_MS)) {
          stopReason = 'window_closed';
          break;
        }
      } else if (await tab.pacedDelay(MIN_INDEED_TAB_DELAY_MS, MAX_INDEED_TAB_DELAY_MS)) {
        stopReason = 'window_closed';
        break;
      }
    }

    if (page > INDEED_AUTO_PAGINATION_MAX_PAGES) {
      stopReason = 'max_pages';
    }
  } finally {
    if (ownsTab) await tab.close();
  }

  // Stops that happen outside a page attempt (window closed during a pause, the max-pages cap)
  // haven't marked any entry yet — attach the reason to the last one so the log always ends on it.
  const lastEntry = pageLog[pageLog.length - 1];
  if (lastEntry && !lastEntry.stopReason) lastEntry.stopReason = stopReason;
  console.log(
    `${logPrefix} run finished — stop: ${stopReason}, ${pagesProcessed} page(s) processed, ${postingsScanned} unique posting(s) ` +
      `scanned of ${indeedTotalJobCount ?? '?'} reported by Indeed (${postingsSaved} new, ${postingsAlreadyKnown} already in DB, ` +
      `${postingsSkippedOutOfRange} out of range)` +
      (errorMessage ? `, last error: ${errorMessage}` : ''),
  );

  return {
    pagesProcessed,
    postingsScanned,
    postingsSaved,
    postingsAlreadyKnown,
    postingsSkippedOutOfRange,
    savedLeads,
    stopReason,
    errorMessage,
    pageLog,
    indeedTotalJobCount,
  };
}
