import { AuthError, saveLeads, type LeadSaveResult } from './api';
import { MAX_TAB_DELAY_MS, MIN_TAB_DELAY_MS, WELLFOUND_CIRCUIT_BREAKER_THRESHOLD } from './wellfound-deepen';
import { pacedDelay, WellfoundBackgroundWindow, WellfoundBackgroundWindowClosedError } from './wellfound-background-window';
import type { JobLead } from './types';

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
class BackgroundListTab {
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
      lastPageProcessed = page;
      pagesProcessed++;

      onProgress({ pageIndex: i + 1, page, batchSize: WELLFOUND_PAGINATION_BATCH_SIZE, leadsFound, leadsSaved });

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

  return { startPage, lastPageProcessed, lastPageAttempted, pagesProcessed, leadsFound, leadsSaved, stopReason, errorMessage };
}
