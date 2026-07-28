import { AuthError, saveLeads } from './api';
import { deepenLeads, type DeepenTarget } from './deepen';
import type { JobLead } from './types';

// CLAUDE.md scope D (DEMO): walks Techjobs list pages via the URL `page` param only — no
// Selenium, no simulated clicks. Runs in the side panel (not the background service worker),
// same reasoning as deepen.ts: a 15-page run with per-lead deepening can take many minutes,
// well past MV3's service-worker suspension window.
export const MAX_PAGES = 15;
// After chrome.tabs.onUpdated reports the navigation "complete", Techjobs' job cards are still
// rendered client-side (confirmed: a plain fetch of the list page returns zero job-card links —
// unlike the detail page, list data isn't in the server-rendered HTML at all) — this is extra
// time for that client render to finish before we ask the content script to parse.
const PAGE_SETTLE_DELAY_MS = 3000;
const MIN_PAGE_DELAY_MS = 2000;
const MAX_PAGE_DELAY_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MultiPageProgress {
  page: number;
  maxPages: number;
  deepenCurrent: number;
  deepenTotal: number;
}

export type MultiPageStopReason = 'reached_target' | 'max_pages' | 'glitch_error' | 'auth_error' | 'nav_error';

export interface MultiPageResult {
  pagesProcessed: number;
  totalLeadsSaved: number;
  stopReason: MultiPageStopReason;
  errorMessage?: string;
}

function buildPageUrl(baseUrl: string, page: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set('page', String(page));
  return url.toString();
}

// Resolves once the tab finishes loading the new URL — a real top-level navigation (not a
// same-page History.pushState), so the content script re-injects fresh on every page.
function navigateAndWaitForLoad(tabId: number, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Navigation timed out.'));
    }, 30000);

    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(chrome.runtime.lastError.message));
      }
    });
  });
}

// null means "couldn't get a real answer" (no content-script listener, tab closed, etc.) —
// the caller treats this the same as a genuinely empty page (see runMultiPageParse).
async function fetchPageLeads(tabId: number): Promise<JobLead[] | null> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PARSE_LIST' });
    if (!res?.ok || !Array.isArray(res.leads)) return null;
    return res.leads as JobLead[];
  } catch {
    return null;
  }
}

function parseDateOnlyToUtcMidnight(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * CLAUDE.md scope D: walks Techjobs list pages 1..N (URL `page` param), saving + deepening
 * every page's leads, until a page's postings are older than `targetDateIso` (inclusive of
 * that date — the covered range is [targetDate .. today]) or the safety cap is hit.
 *
 * Empty-page handling (Techjobs' frontend sometimes loads empty even when it shouldn't):
 * an empty page before the target date is reached is treated as suspicious and retried once
 * (a fresh navigation — this is a real server-side data glitch we've observed, not a client
 * hydration race, so re-parsing the same DOM wouldn't help; only a fresh request might). If
 * still empty, the whole run stops with a clear error rather than silently treating it as the
 * end of the data. An empty page AFTER the target date is already reached is just the normal,
 * expected tail-off — no error.
 *
 * Deliberately does NOT call the Gemini classifier (scope C) — newly deepened leads stay
 * `is_it: 'unprocessed'` until classified later via the existing single-page flow.
 */
export async function runMultiPageParse(
  tabId: number,
  targetDateIso: string,
  onProgress: (progress: MultiPageProgress) => void,
): Promise<MultiPageResult> {
  const targetMidnightUtc = parseDateOnlyToUtcMidnight(targetDateIso);

  const tab = await chrome.tabs.get(tabId);
  const baseUrl = tab.url;
  if (!baseUrl) {
    return { pagesProcessed: 0, totalLeadsSaved: 0, stopReason: 'nav_error', errorMessage: 'Could not read the active tab URL.' };
  }

  let reachedTarget = false;
  let cumulativeDeepened = 0;
  let cumulativeDeepenTotal = 0;
  let totalLeadsSaved = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    onProgress({ page, maxPages: MAX_PAGES, deepenCurrent: cumulativeDeepened, deepenTotal: cumulativeDeepenTotal });

    const pageUrl = buildPageUrl(baseUrl, page);
    try {
      await navigateAndWaitForLoad(tabId, pageUrl);
    } catch (err) {
      return {
        pagesProcessed: page - 1,
        totalLeadsSaved,
        stopReason: 'nav_error',
        errorMessage: `Could not load page ${page}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    await sleep(PAGE_SETTLE_DELAY_MS);

    let leads = await fetchPageLeads(tabId);

    if (!leads || leads.length === 0) {
      if (reachedTarget) {
        return { pagesProcessed: page - 1, totalLeadsSaved, stopReason: 'reached_target' };
      }

      // Suspicious: we haven't reached the target date yet, so this page "should" have had
      // results. Retry once with a fresh navigation before giving up.
      try {
        await navigateAndWaitForLoad(tabId, pageUrl);
        await sleep(PAGE_SETTLE_DELAY_MS);
        leads = await fetchPageLeads(tabId);
      } catch {
        leads = null;
      }

      if (!leads || leads.length === 0) {
        return {
          pagesProcessed: page - 1,
          totalLeadsSaved,
          stopReason: 'glitch_error',
          errorMessage: `Page ${page} returned empty (possible site glitch) — parsing stopped, please check manually.`,
        };
      }
    }

    let saveResults;
    try {
      saveResults = await saveLeads(leads);
    } catch (err) {
      return {
        pagesProcessed: page - 1,
        totalLeadsSaved,
        stopReason: err instanceof AuthError ? 'auth_error' : 'nav_error',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    totalLeadsSaved += leads.length;

    const newTargets: DeepenTarget[] = saveResults
      .filter((r) => r?.lead && !r.lead.description)
      .map((r) => ({ id: r.lead.id, source_url: r.lead.source_url }));
    cumulativeDeepenTotal += newTargets.length;

    if (newTargets.length > 0) {
      await deepenLeads(newTargets, (progress) => {
        onProgress({
          page,
          maxPages: MAX_PAGES,
          deepenCurrent: cumulativeDeepened + progress.current,
          deepenTotal: cumulativeDeepenTotal,
        });
      });
      cumulativeDeepened += newTargets.length;
    }

    if (leads.some((l) => l.published_at && new Date(l.published_at).getTime() < targetMidnightUtc)) {
      return { pagesProcessed: page, totalLeadsSaved, stopReason: 'reached_target' };
    }

    if (page < MAX_PAGES) {
      await sleep(MIN_PAGE_DELAY_MS + Math.random() * (MAX_PAGE_DELAY_MS - MIN_PAGE_DELAY_MS));
    }
  }

  return { pagesProcessed: MAX_PAGES, totalLeadsSaved, stopReason: 'max_pages' };
}
