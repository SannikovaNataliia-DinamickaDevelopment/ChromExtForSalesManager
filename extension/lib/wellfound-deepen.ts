import { deepenLead } from './api';
import type { DeepenedFields, DeepeningStrategy, DeepeningTarget } from './deepening-strategy';

// CLAUDE.md scope D (Wellfound): named + easy to raise once this is validated in practice.
export const WELLFOUND_RUN_CAP = 20;
export const WELLFOUND_CIRCUIT_BREAKER_THRESHOLD = 3;

// Wellfound is known to be anti-bot-aggressive — meaningfully slower/more cautious pacing
// than the 1.5-3s used for the plain-fetch strategy (deepen.ts).
const MIN_TAB_DELAY_MS = 4000;
const MAX_TAB_DELAY_MS = 8000;
const NAV_TIMEOUT_MS = 30000;
// After navigation "complete", give the content script's onMessage listener a moment to be
// registered before messaging it (same race multipage.ts guards against with its own settle
// delay). The content script itself then polls up to 15s for the JSON-LD to actually appear.
const CONTENT_SCRIPT_SETTLE_MS = 1000;
// Comfortably above the content script's own 15s poll timeout — this is a backstop for
// truly broken channels (tab crashed, no listener at all), not the primary timeout.
const EXTRACT_TIMEOUT_MS = 20000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function navigateAndWaitForLoad(tabId: number, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Navigation timed out.'));
    }, NAV_TIMEOUT_MS);

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

interface ExtractResponse {
  ok: boolean;
  detail?: DeepenedFields;
  error?: string;
}

/**
 * CLAUDE.md scope D (Wellfound): deepens via a real browser tab instead of a background
 * fetch(). Confirmed necessary with a real curl against a live detail URL — Wellfound's
 * DataDome bot-protection returns HTTP 403 with a JS challenge page for any non-browser
 * request (Set-Cookie: datadome=..., X-DataDome: protected). The JSON-LD JobPosting is
 * genuinely present once a real browser renders the page (confirmed against
 * spikes/Wellfound_detail.html) — it's an access problem, not a parsing problem.
 *
 * Runs ONE dedicated, minimized, unfocused popup window for the whole run — never the
 * manager's active window/tab — and reuses its single tab across every lead by navigating it,
 * the same tab-reuse pattern multipage.ts already uses for Techjobs pagination.
 */
export class TabDeepening implements DeepeningStrategy {
  private windowId: number | null = null;
  private tabId: number | null = null;

  private async ensureTab(): Promise<number> {
    if (this.tabId !== null) return this.tabId;

    const win = await chrome.windows.create({
      url: 'about:blank',
      type: 'popup',
      state: 'minimized',
      focused: false,
    });

    this.windowId = win.id ?? null;
    let tabId = win.tabs?.[0]?.id;
    if (tabId === undefined && this.windowId !== null) {
      const tabs = await chrome.tabs.query({ windowId: this.windowId });
      tabId = tabs[0]?.id;
    }
    if (tabId === undefined) {
      throw new Error('Could not create a background window for Wellfound deepening.');
    }
    this.tabId = tabId;
    return tabId;
  }

  async deepenOne(target: DeepeningTarget): Promise<DeepenedFields | null> {
    const tabId = await this.ensureTab();

    await navigateAndWaitForLoad(tabId, target.source_url);
    await sleep(CONTENT_SCRIPT_SETTLE_MS);

    const res = await Promise.race<ExtractResponse>([
      chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_WELLFOUND_DETAIL' }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Extraction timed out.')), EXTRACT_TIMEOUT_MS);
      }),
    ]);

    return res?.ok && res.detail ? res.detail : null;
  }

  // Closes the dedicated window. Call once at the end of a run (success, cap, or circuit
  // breaker) — never leave an extra background window open.
  async close(): Promise<void> {
    if (this.windowId !== null) {
      try {
        await chrome.windows.remove(this.windowId);
      } catch {
        // Already closed — nothing to do.
      }
    }
    this.windowId = null;
    this.tabId = null;
  }
}

export interface WellfoundDeepenProgress {
  current: number;
  total: number;
  succeeded: number;
  stoppedEarly: boolean;
}

export interface WellfoundDeepenResult {
  processed: number;
  succeeded: number;
  stoppedEarly: boolean;
}

/**
 * Sequential, human-paced, capped at WELLFOUND_RUN_CAP leads per run. Stops immediately (the
 * circuit breaker) after WELLFOUND_CIRCUIT_BREAKER_THRESHOLD consecutive failures rather than
 * continuing to hammer what's likely a blocked session — surfaced to the caller via
 * `stoppedEarly`, never silently swallowed (NFR-12/13).
 */
export async function deepenWellfoundLeads(
  targets: DeepeningTarget[],
  onProgress: (progress: WellfoundDeepenProgress) => void,
): Promise<WellfoundDeepenResult> {
  const capped = targets.slice(0, WELLFOUND_RUN_CAP);
  const strategy = new TabDeepening();

  let succeeded = 0;
  let consecutiveFailures = 0;
  let stoppedEarly = false;
  let processed = 0;

  try {
    for (let i = 0; i < capped.length; i++) {
      const target = capped[i];
      let detail: DeepenedFields | null = null;
      let saveFailed = false;

      try {
        detail = await strategy.deepenOne(target);
        if (detail) {
          await deepenLead(target.id, {
            description: detail.description,
            company: detail.company,
            company_website: detail.company_website,
            ...(detail.published_at ? { published_at: detail.published_at } : {}),
          });
        }
      } catch {
        // Swallow: one bad tab/lead must not abort the run — counted as a failure below.
        // If `detail` is already set, deepenOne() succeeded and the backend PATCH failed;
        // otherwise deepenOne() itself failed and `detail` is still its initial null.
        if (detail) saveFailed = true;
      }
      processed++;

      if (detail && !saveFailed) {
        succeeded++;
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
      }

      if (consecutiveFailures >= WELLFOUND_CIRCUIT_BREAKER_THRESHOLD) {
        stoppedEarly = true;
        onProgress({ current: processed, total: capped.length, succeeded, stoppedEarly: true });
        break;
      }

      onProgress({ current: processed, total: capped.length, succeeded, stoppedEarly: false });

      if (i < capped.length - 1) {
        await sleep(MIN_TAB_DELAY_MS + Math.random() * (MAX_TAB_DELAY_MS - MIN_TAB_DELAY_MS));
      }
    }
  } finally {
    await strategy.close();
  }

  return { processed, succeeded, stoppedEarly };
}
