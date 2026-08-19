import { formatKyivDate } from './format-time';
import { AuthError, saveLeads, type LeadSaveResult } from './api';
import {
  MAX_TAB_DELAY_MS,
  MIN_TAB_DELAY_MS,
  WELLFOUND_AUTO_BATCH_PAUSE_MAX_MS,
  WELLFOUND_AUTO_BATCH_PAUSE_MIN_MS,
  WELLFOUND_AUTO_BATCH_POSTINGS,
  WELLFOUND_CIRCUIT_BREAKER_THRESHOLD,
} from './wellfound-deepen';
import { isWithinRange, parseWellfoundRelativePosted } from './wellfound-relative-date';
import { pacedDelay, WellfoundBackgroundWindow, WellfoundBackgroundWindowClosedError } from './wellfound-background-window';
import type { JobLead } from './types';

// LEGACY (19.08 call): the fixed-5-page-batch flow below (runWellfoundPagination and
// everything through WellfoundPaginationResult) is no longer surfaced in the side panel UI —
// see App.tsx's SHOW_LEGACY_WELLFOUND_PAGINATION — replaced for normal use by
// runWellfoundAutoPagination further down, which walks every page instead of a fixed batch and
// filters inline by a manager-picked date range. Kept, not deleted: a significant behavior
// change with a real fallback path if it needs to be rolled back.
//
// A fixed page-count batch, not date-based: unlike Techjobs/ITjobs (multipage.ts), Wellfound's
// list only exposes relative posted-time text ("4 days ago") — not reliable enough to stop on
// a target date, see CLAUDE.md. Named + easy to raise, same convention as
// wellfound-deepen.ts's WELLFOUND_RUN_CAP.
export const WELLFOUND_PAGINATION_BATCH_SIZE = 5;

// Same reasoning as multipage.ts's own PAGE_SETTLE_DELAY_MS (that file is Techjobs/ITjobs-only
// and stays untouched, so this is a second, Wellfound-scoped copy, not a shared import):
// chrome.tabs.onUpdated reports 'complete' once the initial response lands, but Wellfound's
// list is Next.js client-hydrated like its detail page (see wellfound-deepen.ts's own
// hydration comment) — extra time for cards to actually render before we ask the content
// script to parse.
const PAGE_SETTLE_DELAY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPageUrl(baseUrl: string, page: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set('page', String(page));
  return url.toString();
}

function actualPageParam(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get('page');
  } catch {
    return null;
  }
}

interface ParseListResponse {
  ok: boolean;
  leads?: unknown;
  error?: string;
}

// Dedicated, minimized, unfocused popup window + single reused tab — WellfoundBackgroundWindow
// (shared with wellfound-deepen.ts's TabDeepening) applied to list pages instead of a detail
// page. A thin wrapper rather than using WellfoundBackgroundWindow directly everywhere below:
// keeps the "navigate, settle, PARSE_LIST, read final URL" sequence in one place.
export class BackgroundListTab {
  private readonly win = new WellfoundBackgroundWindow('pagination');

  // Navigates to the given list page URL and returns both the parsed leads and the tab's final
  // URL (post any site-side redirect) — the caller uses the final URL to detect an out-of-range
  // page (see runWellfoundPagination's "no more pages" check). Throws
  // WellfoundBackgroundWindowClosedError if the background window is gone.
  async loadPage(url: string): Promise<{ leads: JobLead[]; finalUrl: string | null }> {
    await this.win.navigate(url);
    await sleep(PAGE_SETTLE_DELAY_MS);

    const finalUrl = await this.win.getTabUrl();
    const res = await this.win.sendMessage<ParseListResponse>({ type: 'PARSE_LIST' });

    if (!res?.ok || !Array.isArray(res.leads)) {
      throw new Error(res?.error ?? 'Could not parse this page.');
    }

    return { leads: res.leads as JobLead[], finalUrl };
  }

  get wasClosedByUser(): boolean {
    return this.win.wasClosedByUser;
  }

  pacedDelay(minMs: number, maxMs: number): Promise<boolean> {
    return pacedDelay(this.win, minMs, maxMs);
  }

  // Exposes the shared window's live-progress-text overlay update without leaking the window
  // instance itself outside this class.
  setProgress(text: string): void {
    this.win.setProgress(text);
  }

  // Pushes the current progress text to the overlay on whatever page is loaded RIGHT NOW,
  // without navigating — used by runWellfoundAutoPagination to show a live "batch pause"
  // message during its inter-batch cooldown, not just on the next page's navigate() call.
  refreshOverlay(): Promise<void> {
    return this.win.refreshOverlay();
  }

  // Closes the dedicated window. Call once at the end of a run — never leave an extra
  // background window open (same rule as TabDeepening.close()).
  async close(): Promise<void> {
    await this.win.close();
  }
}

export interface WellfoundPaginationProgress {
  pageIndex: number; // 1-based position within this batch (1..WELLFOUND_PAGINATION_BATCH_SIZE)
  page: number; // the actual Wellfound page number just attempted
  batchSize: number;
  leadsFound: number;
  leadsSaved: number;
}

export type WellfoundPaginationStopReason =
  | 'batch_size'
  | 'no_more_pages'
  | 'circuit_breaker'
  | 'window_closed'
  | 'auth_error'
  | 'fatal_error';

export interface WellfoundPaginationResult {
  startPage: number;
  // Last page successfully parsed AND saved. startPage - 1 if none succeeded — this is what
  // the caller bookmarks, so a failed page (or a window-closed interruption) is retried on the
  // next "Continue" rather than silently skipped.
  lastPageProcessed: number;
  // Last page number the loop actually attempted, success or failure — startPage - 1 if the
  // loop never ran an iteration. Lets the caller report exactly which page a circuit-breaker
  // stop or a "no more pages" redirect happened on, distinct from lastPageProcessed.
  lastPageAttempted: number;
  pagesProcessed: number;
  leadsFound: number;
  // Newly inserted (not deduplicated) leads across the whole run — distinct from leadsFound,
  // which counts every card parsed off every page including ones that turned out to be
  // dedup updates to an already-known lead.
  leadsSaved: number;
  // Every saveLeads() result across every successfully-saved page in this run, in save order —
  // exactly (and only) what THIS run parsed and saved, never a broader "everything still
  // pending in the DB" set. Exists so a caller can auto-deepen precisely this run's leads by
  // reusing the same LeadSaveResult[] shape App.tsx's single-page-parse flow already deepens
  // from (runWellfoundDeepen), rather than needing a separate DB query.
  savedLeads: LeadSaveResult[];
  stopReason: WellfoundPaginationStopReason;
  errorMessage?: string;
}

/**
 * Wellfound-only list-page pagination — deliberately separate from multipage.ts's
 * Techjobs/ITjobs "parse pages back to date" (that file stays untouched). Walks a fixed batch
 * of WELLFOUND_PAGINATION_BATCH_SIZE pages via the confirmed `?page=N` URL scheme (verified
 * live against a real Wellfound search: identical shape to Techjobs' own `?page=N`, and an
 * out-of-range page redirects back to the bare page-1 URL — the "no more pages" signal used
 * below), using a dedicated background/unfocused window at the same human pace already used
 * for Wellfound detail-page deepening (wellfound-deepen.ts's MIN/MAX_TAB_DELAY_MS).
 *
 * Deliberately does NOT deepen or classify — this only lists and saves. Leads it finds land in
 * the same "missing description" state a fell-out-of-deepening lead would, already handled by
 * the dashboard's existing per-lead "Enrich" button and bulk "Enrich selected" action.
 *
 * A failure (page load error, or the save call itself failing) does not stop the run by
 * itself — it counts toward the circuit breaker and the walk moves on to the next page number,
 * same as deepenWellfoundLeads' one-attempt-per-item model (no same-page retry). Closing the
 * background window mid-run stops the walk immediately and distinctly (stopReason
 * 'window_closed', not counted against the circuit breaker) — whatever was already saved stays
 * saved, and lastPageProcessed reflects exactly how far the walk got, so the caller's bookmark
 * (and therefore "Continue") picks up from the right place.
 */
export async function runWellfoundPagination(
  baseUrl: string,
  startPage: number,
  onProgress: (progress: WellfoundPaginationProgress) => void,
): Promise<WellfoundPaginationResult> {
  const tab = new BackgroundListTab();

  let leadsFound = 0;
  let leadsSaved = 0;
  let lastPageProcessed = startPage - 1;
  let lastPageAttempted = startPage - 1;
  let pagesProcessed = 0;
  let consecutiveFailures = 0;
  let stopReason: WellfoundPaginationStopReason = 'batch_size';
  let errorMessage: string | undefined;
  const savedLeads: LeadSaveResult[] = [];

  const isClosedError = (err: unknown) => err instanceof WellfoundBackgroundWindowClosedError || tab.wasClosedByUser;

  try {
    for (let i = 0; i < WELLFOUND_PAGINATION_BATCH_SIZE; i++) {
      const page = startPage + i;
      lastPageAttempted = page;
      const pageUrl = buildPageUrl(baseUrl, page);

      let leads: JobLead[];
      let finalUrl: string | null;
      try {
        ({ leads, finalUrl } = await tab.loadPage(pageUrl));
      } catch (err) {
        if (isClosedError(err)) {
          stopReason = 'window_closed';
          break;
        }
        errorMessage = err instanceof Error ? err.message : String(err);
        consecutiveFailures++;
        if (consecutiveFailures >= WELLFOUND_CIRCUIT_BREAKER_THRESHOLD) {
          stopReason = 'circuit_breaker';
          break;
        }
        onProgress({ pageIndex: i + 1, page, batchSize: WELLFOUND_PAGINATION_BATCH_SIZE, leadsFound, leadsSaved });
        if (i < WELLFOUND_PAGINATION_BATCH_SIZE - 1) {
          if (await tab.pacedDelay(MIN_TAB_DELAY_MS, MAX_TAB_DELAY_MS)) {
            stopReason = 'window_closed';
            break;
          }
        }
        continue;
      }

      // Wellfound redirects (the `page` param comes back stripped/changed) once you go past
      // its last real page — confirmed live: requesting page 999 of a 46-page search came back
      // as the bare page-1 URL. The same check also covers a genuinely empty (non-redirected)
      // page: either way, there's nothing further to walk, and the mismatched/empty page's
      // content must NOT be saved under the wrong page number.
      const actualPage = actualPageParam(finalUrl);
      if (actualPage !== String(page) || leads.length === 0) {
        stopReason = 'no_more_pages';
        break;
      }

      let saveResults: LeadSaveResult[];
      try {
        saveResults = await saveLeads(leads);
      } catch (err) {
        if (err instanceof AuthError) {
          stopReason = 'auth_error';
          errorMessage = err.message;
          break;
        }
        errorMessage = err instanceof Error ? err.message : String(err);
        consecutiveFailures++;
        if (consecutiveFailures >= WELLFOUND_CIRCUIT_BREAKER_THRESHOLD) {
          stopReason = 'circuit_breaker';
          break;
        }
        onProgress({ pageIndex: i + 1, page, batchSize: WELLFOUND_PAGINATION_BATCH_SIZE, leadsFound, leadsSaved });
        if (i < WELLFOUND_PAGINATION_BATCH_SIZE - 1) {
          if (await tab.pacedDelay(MIN_TAB_DELAY_MS, MAX_TAB_DELAY_MS)) {
            stopReason = 'window_closed';
            break;
          }
        }
        continue;
      }

      consecutiveFailures = 0;
      leadsFound += leads.length;
      leadsSaved += saveResults.filter((r) => r?.lead && !r.deduplicated).length;
      savedLeads.push(...saveResults);
      lastPageProcessed = page;
      pagesProcessed++;

      onProgress({ pageIndex: i + 1, page, batchSize: WELLFOUND_PAGINATION_BATCH_SIZE, leadsFound, leadsSaved });
      // Live count in the "don't close this window" overlay, shown on the NEXT navigate() —
      // reflects pages actually completed so far, matching pagesProcessed's own semantics
      // (successful saves only, not attempts) so the two numbers a manager might compare stay
      // consistent.
      tab.setProgress(`Page ${pagesProcessed}/${WELLFOUND_PAGINATION_BATCH_SIZE} processed, ${leadsFound} lead(s) found so far`);

      if (i < WELLFOUND_PAGINATION_BATCH_SIZE - 1) {
        if (await tab.pacedDelay(MIN_TAB_DELAY_MS, MAX_TAB_DELAY_MS)) {
          stopReason = 'window_closed';
          break;
        }
      }
    }
  } finally {
    await tab.close();
  }

  return { startPage, lastPageProcessed, lastPageAttempted, pagesProcessed, leadsFound, leadsSaved, savedLeads, stopReason, errorMessage };
}

// Pure runaway-loop safety net, not a real business limit — the 19.08 spec is explicit that
// every page must be walked, no cap. A normal run stops via 'no_more_pages' (the site's own
// out-of-range-page redirect, same detection as the legacy flow above) or the circuit breaker
// long before this could ever matter. Named + easy to raise, same convention as every other
// Wellfound constant in this file.
export const WELLFOUND_AUTO_PAGINATION_MAX_PAGES = 500;

export interface WellfoundAutoPaginationProgress {
  page: number;
  postingsScanned: number;
  postingsSaved: number;
  postingsSkippedOutOfRange: number;
  phase: 'scanning' | 'batch_pause';
}

export type WellfoundAutoPaginationStopReason =
  | 'no_more_pages'
  | 'circuit_breaker'
  | 'window_closed'
  | 'auth_error'
  | 'max_pages';

export interface WellfoundAutoPaginationResult {
  pagesProcessed: number;
  postingsScanned: number;
  // In-range AND newly inserted (not a dedup update) — same "actually new" semantics as the
  // legacy flow's leadsSaved.
  postingsSaved: number;
  postingsSkippedOutOfRange: number;
  // Every saveLeads() result across every page's in-range subset in this run, in save order —
  // feeds runWellfoundAutoDeepenWaves the same way the legacy flow feeds runWellfoundDeepen.
  savedLeads: LeadSaveResult[];
  stopReason: WellfoundAutoPaginationStopReason;
  errorMessage?: string;
}

/**
 * 19.08 call: fully automated Wellfound multi-page parse. Replaces the legacy fixed-5-page-
 * batch flow above for normal use (that flow stays in the code, just no longer rendered — see
 * App.tsx's SHOW_LEGACY_WELLFOUND_PAGINATION) with a single "Parse" click that walks EVERY page
 * of the current search result — no page cap (WELLFOUND_AUTO_PAGINATION_MAX_PAGES above is a
 * safety net only), no "click Continue" step.
 *
 * Deliberately does NOT reuse multipage.ts's (Techjobs/ITjobs) early-stop-at-target-date logic:
 * that assumes the list is chronologically sorted and stops at the first out-of-range posting.
 * Wellfound's list is grouped by company instead (CLAUDE.md "Parser spec" / WellfoundListParser
 * walks the DOM in document order remembering the nearest preceding company header) — a
 * relevant posting can appear on ANY page regardless of its date, so the only valid stop
 * conditions here are "no more pages" (the site's own out-of-range redirect, same check as the
 * legacy flow) or the circuit breaker. A page whose postings are ALL out of range is NOT a stop
 * signal — see the loop below, where the no-more-pages check happens on the raw (pre-filter)
 * leads array, never on how many of them survived the date filter.
 *
 * Range filtering happens per-posting as each page is scanned
 * (wellfound-relative-date.ts's parseWellfoundRelativePosted — necessarily an approximation,
 * since Wellfound's list only ever exposes relative text like "4 days ago", see that file for
 * why). An in-range posting is saved immediately as part of that page's batch; an out-of-range
 * one is discarded on the spot and never sent to saveLeads at all — there is no staging step.
 *
 * Pacing is two-layered: the existing per-page human-pace delay (MIN/MAX_TAB_DELAY_MS, same as
 * the legacy flow) between every page navigation, PLUS a longer cooldown pause
 * (WELLFOUND_AUTO_BATCH_PAUSE_MIN/MAX_MS) after every WELLFOUND_AUTO_BATCH_POSTINGS postings
 * scanned — batched by postings actually crawled (not postings saved), since the anti-bot
 * concern is about how much traffic this generates against Wellfound, independent of how many
 * results happened to match the manager's date range. The batch-pause also pushes a live
 * overlay update via tab.refreshOverlay() so the "don't close this window" banner reflects the
 * pause, not just stale text from the last page navigation.
 */
export async function runWellfoundAutoPagination(
  baseUrl: string,
  range: { start: string; end: string },
  onProgress: (progress: WellfoundAutoPaginationProgress) => void,
): Promise<WellfoundAutoPaginationResult> {
  const tab = new BackgroundListTab();
  // Fixed for the whole run rather than re-derived per page — a run can span many minutes
  // (unbounded pages + batch pauses), and holding one "today" throughout keeps every posting on
  // every page measured against the same anchor instead of subtly drifting if the run happens
  // to cross a Kyiv midnight boundary mid-run. A deliberate simplification, not an oversight.
  const todayIso = formatKyivDate(new Date().toISOString());

  let page = 1;
  let pagesProcessed = 0;
  let postingsScanned = 0;
  let postingsSaved = 0;
  let postingsSkippedOutOfRange = 0;
  let sinceLastPause = 0;
  let consecutiveFailures = 0;
  let stopReason: WellfoundAutoPaginationStopReason = 'no_more_pages';
  let errorMessage: string | undefined;
  const savedLeads: LeadSaveResult[] = [];

  const isClosedError = (err: unknown) => err instanceof WellfoundBackgroundWindowClosedError || tab.wasClosedByUser;
  const emitProgress = (phase: WellfoundAutoPaginationProgress['phase']) =>
    onProgress({ page, postingsScanned, postingsSaved, postingsSkippedOutOfRange, phase });

  try {
    while (page <= WELLFOUND_AUTO_PAGINATION_MAX_PAGES) {
      const pageUrl = buildPageUrl(baseUrl, page);

      let leads: JobLead[];
      let finalUrl: string | null;
      try {
        ({ leads, finalUrl } = await tab.loadPage(pageUrl));
      } catch (err) {
        if (isClosedError(err)) {
          stopReason = 'window_closed';
          break;
        }
        errorMessage = err instanceof Error ? err.message : String(err);
        consecutiveFailures++;
        if (consecutiveFailures >= WELLFOUND_CIRCUIT_BREAKER_THRESHOLD) {
          stopReason = 'circuit_breaker';
          break;
        }
        emitProgress('scanning');
        if (await tab.pacedDelay(MIN_TAB_DELAY_MS, MAX_TAB_DELAY_MS)) {
          stopReason = 'window_closed';
          break;
        }
        page++;
        continue;
      }

      // Same out-of-range-page redirect detection as the legacy flow — checked on the RAW
      // leads array, before date filtering, since an all-filtered-out page must NOT be
      // mistaken for the end of the results (see this function's doc comment, point 4).
      const actualPage = actualPageParam(finalUrl);
      if (actualPage !== String(page) || leads.length === 0) {
        stopReason = 'no_more_pages';
        break;
      }

      const inRange = leads.filter((lead) => {
        const postedRelative = (lead.snapshot as { posted_relative?: string } | undefined)?.posted_relative;
        const approx = parseWellfoundRelativePosted(postedRelative, todayIso);
        return approx === null || isWithinRange(approx, range.start, range.end);
      });
      const outOfRangeCount = leads.length - inRange.length;

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
          if (consecutiveFailures >= WELLFOUND_CIRCUIT_BREAKER_THRESHOLD) {
            stopReason = 'circuit_breaker';
            break;
          }
          emitProgress('scanning');
          if (await tab.pacedDelay(MIN_TAB_DELAY_MS, MAX_TAB_DELAY_MS)) {
            stopReason = 'window_closed';
            break;
          }
          page++;
          continue;
        }
      }

      consecutiveFailures = 0;
      pagesProcessed++;
      const savedThisPage = saveResults.filter((r) => r?.lead && !r.deduplicated).length;
      postingsScanned += leads.length;
      postingsSkippedOutOfRange += outOfRangeCount;
      postingsSaved += savedThisPage;
      savedLeads.push(...saveResults);
      sinceLastPause += leads.length;

      tab.setProgress(
        `Page ${page} scanned — ${postingsScanned} posting(s) seen, ${postingsSaved} saved, ${postingsSkippedOutOfRange} out of range so far`,
      );
      emitProgress('scanning');
      page++;

      if (sinceLastPause >= WELLFOUND_AUTO_BATCH_POSTINGS) {
        sinceLastPause = 0;
        tab.setProgress(
          `Batch pause (anti-bot cooldown) — resuming automatically. ${postingsScanned} posting(s) scanned so far, ${postingsSaved} saved, ${postingsSkippedOutOfRange} out of range.`,
        );
        await tab.refreshOverlay();
        emitProgress('batch_pause');
        if (await tab.pacedDelay(WELLFOUND_AUTO_BATCH_PAUSE_MIN_MS, WELLFOUND_AUTO_BATCH_PAUSE_MAX_MS)) {
          stopReason = 'window_closed';
          break;
        }
      } else if (await tab.pacedDelay(MIN_TAB_DELAY_MS, MAX_TAB_DELAY_MS)) {
        stopReason = 'window_closed';
        break;
      }
    }

    if (page > WELLFOUND_AUTO_PAGINATION_MAX_PAGES) {
      stopReason = 'max_pages';
    }
  } finally {
    await tab.close();
  }

  return { pagesProcessed, postingsScanned, postingsSaved, postingsSkippedOutOfRange, savedLeads, stopReason, errorMessage };
}
