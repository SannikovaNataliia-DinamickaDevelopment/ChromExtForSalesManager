import { AuthError, saveLeads, type LeadSaveResult } from './api';
import { formatKyivDate } from './format-time';
import { IndeedBackgroundWindow, IndeedBackgroundWindowClosedError, pacedDelay } from './indeed-background-window';
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

function buildPageUrl(baseUrl: string, start: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set('start', String(start));
  return url.toString();
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
  error?: string;
}

interface LoadPageResult {
  signInRequired: boolean;
  leads: JobLead[];
  finalUrl: string | null;
}

// Thin wrapper around IndeedBackgroundWindow, mirroring wellfound-pagination.ts's
// BackgroundListTab shape — keeps the "navigate, settle, check sign-in wall, PARSE_LIST" sequence
// in one place.
class IndeedBackgroundListTab {
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
      return { signInRequired: true, leads: [], finalUrl };
    }

    const res = await this.win.sendMessage<ParseListResponse>({ type: 'PARSE_LIST' });
    if (!res?.ok || !Array.isArray(res.leads)) {
      throw new Error(res?.error ?? 'Could not parse this page.');
    }

    return { signInRequired: false, leads: res.leads as JobLead[], finalUrl };
  }

  get wasClosedByUser(): boolean {
    return this.win.wasClosedByUser;
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
 * this only needs one direct comparison — `isWithinRange(formatKyivDate(lead.published_at),
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
export async function runIndeedAutoPagination(
  baseUrl: string,
  range: { start: string; end: string },
  onProgress: (progress: IndeedAutoPaginationProgress) => void,
): Promise<IndeedAutoPaginationResult> {
  const tab = new IndeedBackgroundListTab();

  let start = 0;
  let page = 1;
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

  const isClosedError = (err: unknown) => err instanceof IndeedBackgroundWindowClosedError || tab.wasClosedByUser;
  const emitProgress = (phase: IndeedAutoPaginationProgress['phase']) =>
    onProgress({ page, postingsScanned, postingsSaved, postingsAlreadyKnown, postingsSkippedOutOfRange, phase });

  try {
    while (page <= INDEED_AUTO_PAGINATION_MAX_PAGES) {
      const pageUrl = buildPageUrl(baseUrl, start);

      let signInRequired: boolean;
      let leads: JobLead[];
      try {
        ({ signInRequired, leads } = await tab.loadPage(pageUrl));
      } catch (err) {
        if (isClosedError(err)) {
          stopReason = 'window_closed';
          break;
        }
        errorMessage = err instanceof Error ? err.message : String(err);
        consecutiveFailures++;
        if (consecutiveFailures >= INDEED_CIRCUIT_BREAKER_THRESHOLD) {
          stopReason = 'circuit_breaker';
          break;
        }
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
        break;
      }

      // Primary "no more pages" signal — see this function's doc comment for why an empty
      // array (from a page that parsed successfully, i.e. didn't throw) is trusted here rather
      // than any URL-redirect pattern, which is unconfirmed for Indeed. Checked on the RAW
      // leads array, before date filtering below, so an all-filtered-out page is never
      // mistaken for the end of the results.
      if (leads.length === 0) {
        stopReason = 'no_more_pages';
        break;
      }

      // Only postings not already seen earlier in this run — see seenJobKeys. Overlapping pages
      // (Indeed's step is 10 while a page shows ~15) also land here, so a repeat is never
      // re-saved or re-counted. Also checked before date filtering, for the same reason as the
      // empty check above.
      const newLeads = leads.filter((lead) => !seenJobKeys.has(lead.external_job_id));
      if (newLeads.length === 0) {
        stopReason = 'no_more_pages';
        break;
      }
      for (const lead of newLeads) seenJobKeys.add(lead.external_job_id);

      // 24.09 follow-up (date-range filter) — see this function's doc comment for why this is a
      // single direct comparison rather than Wellfound's precise-or-approximate fallback chain.
      const inRange = newLeads.filter((lead) => {
        if (!lead.published_at) return true; // no date to judge by — fail open, never silently drop a lead
        return isWithinRange(formatKyivDate(lead.published_at), range.start, range.end);
      });
      const outOfRangeCount = newLeads.length - inRange.length;

      let saveResults: LeadSaveResult[] = [];
      if (inRange.length > 0) {
        try {
          saveResults = await saveLeads(inRange);
        } catch (err) {
          if (err instanceof AuthError) {
            stopReason = 'auth_error';
            errorMessage = err.message;
            break;
          }
          errorMessage = err instanceof Error ? err.message : String(err);
          consecutiveFailures++;
          if (consecutiveFailures >= INDEED_CIRCUIT_BREAKER_THRESHOLD) {
            stopReason = 'circuit_breaker';
            break;
          }
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

      tab.setProgress(
        `Page ${page} scanned — ${postingsScanned} posting(s) seen, ${postingsSaved} new, ${postingsAlreadyKnown} already in DB, ` +
          `${postingsSkippedOutOfRange} out of range so far`,
      );
      emitProgress('scanning');
      page++;
      start += INDEED_START_INCREMENT;

      if (pagesSinceLastPause >= INDEED_AUTO_BATCH_PAGES) {
        pagesSinceLastPause = 0;
        tab.setProgress(
          `Batch pause (anti-bot cooldown) — resuming automatically. ${postingsScanned} posting(s) scanned so far, ${postingsSaved} new, ` +
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
    await tab.close();
  }

  return {
    pagesProcessed,
    postingsScanned,
    postingsSaved,
    postingsAlreadyKnown,
    postingsSkippedOutOfRange,
    savedLeads,
    stopReason,
    errorMessage,
  };
}
