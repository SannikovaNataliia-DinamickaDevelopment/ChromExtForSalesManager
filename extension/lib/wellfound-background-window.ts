// Shared "dedicated, minimized, unfocused popup window" lifecycle for every Wellfound flow
// that needs a real browser tab instead of a fetch — TabDeepening (wellfound-deepen.ts, detail
// pages) and BackgroundListTab (wellfound-pagination.ts, list pages). Extracted once both
// needed the identical create/reuse/close mechanics, so closure-resilience (this file's whole
// reason to exist) is fixed in one place instead of drifting between two copies.
//
// Chrome gives an extension no way to block a window from being closed or force a reliable
// native "are you sure" dialog on close — that's a deliberate browser security restriction, not
// something to code around. So instead of trying to prevent closure, this makes an accidental
// closure detectable mid-run (chrome.windows.onRemoved) so callers can stop cleanly, keep
// whatever progress they already made, and surface a clear "interrupted, resume with X" message
// instead of hanging or silently misreporting the failure as an anti-bot block.

export class WellfoundBackgroundWindowClosedError extends Error {
  constructor() {
    super('The Wellfound background window was closed before this run finished.');
    this.name = 'WellfoundBackgroundWindowClosedError';
  }
}

interface BackgroundMessageResponse {
  ok?: boolean;
}

export class WellfoundBackgroundWindow {
  private windowId: number | null = null;
  private tabId: number | null = null;
  private closed = false;
  private closedListener: ((windowId: number) => void) | null = null;
  // Shown via content.ts's SHOW_BACKGROUND_OVERLAY after every navigation (CLAUDE.md-style
  // note: a fresh page load wipes the previous page's DOM, overlay included, so it has to be
  // re-injected each time, not shown once) — short label distinguishing what's running for
  // the message text, e.g. "deepening" or "pagination".
  constructor(private readonly overlayLabel: string) {}

  get wasClosedByUser(): boolean {
    return this.closed;
  }

  private async ensureTab(): Promise<number> {
    if (this.closed) {
      throw new WellfoundBackgroundWindowClosedError();
    }
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
      throw new Error('Could not create a background window for Wellfound.');
    }
    this.tabId = tabId;

    // Fires whether the manager closes the window itself or closes its one tab (a popup
    // window has exactly one tab, so either action removes the whole window) — one listener
    // covers both. Chrome can't be asked to block or confirm this, only to notify after it
    // already happened, hence the "make it recoverable" approach documented above.
    const windowId = this.windowId;
    this.closedListener = (removedWindowId: number) => {
      if (removedWindowId === windowId) {
        this.closed = true;
      }
    };
    chrome.windows.onRemoved.addListener(this.closedListener);

    return tabId;
  }

  // Navigates the shared tab and (best-effort) shows the "please don't close this" overlay on
  // the freshly-loaded page. Throws WellfoundBackgroundWindowClosedError if the window is gone
  // either before or immediately after the navigation.
  async navigate(url: string): Promise<void> {
    const tabId = await this.ensureTab();
    await navigateAndWaitForLoad(tabId, url);
    if (this.closed) {
      throw new WellfoundBackgroundWindowClosedError();
    }
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'SHOW_BACKGROUND_OVERLAY', label: this.overlayLabel });
    } catch {
      // Best-effort — a failed overlay injection (e.g. content script not yet registered) must
      // never abort real work. The overlay is a visual warning, not a safety mechanism.
    }
  }

  async sendMessage<T extends BackgroundMessageResponse>(message: unknown): Promise<T> {
    if (this.closed || this.tabId === null) {
      throw new WellfoundBackgroundWindowClosedError();
    }
    return chrome.tabs.sendMessage(this.tabId, message) as Promise<T>;
  }

  // Used by wellfound-pagination.ts to read the tab's post-navigation URL (site-side redirects
  // signal "no more pages" there). Returns null on any failure, including a closed window —
  // callers already treat a null/mismatched URL as "stop", and the outer loop's own
  // wasClosedByUser check still catches the closure precisely on the next operation.
  async getTabUrl(): Promise<string | null> {
    if (this.tabId === null || this.closed) return null;
    try {
      const tab = await chrome.tabs.get(this.tabId);
      return tab.url ?? null;
    } catch {
      return null;
    }
  }

  // Human-pace delay that's abortable by the window closing mid-wait, instead of only being
  // noticed on the next navigation/message attempt — a closure during the "wait between pages"
  // stretch (a large fraction of any run's wall-clock time) should be caught right away, not
  // several seconds late.
  async delayOrThrowIfClosed(ms: number): Promise<void> {
    if (this.closed) {
      throw new WellfoundBackgroundWindowClosedError();
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        resolve();
      }, ms);
      // No cheaper "wait for event" primitive than a short poll here — ms is already a
      // multi-second human-pace delay, so 250ms poll granularity is negligible overhead.
      const poll = setInterval(() => {
        if (this.closed) {
          clearTimeout(timer);
          clearInterval(poll);
          reject(new WellfoundBackgroundWindowClosedError());
        }
      }, 250);
    });
  }

  // Closes the dedicated window. Call once at the end of a run (success, cap, circuit breaker,
  // or closure already detected) — never leave an extra background window open. Safe to call
  // even when the window is already gone (closedListener removal + chrome.windows.remove are
  // both no-ops in that case).
  async close(): Promise<void> {
    if (this.closedListener) {
      chrome.windows.onRemoved.removeListener(this.closedListener);
      this.closedListener = null;
    }
    if (this.windowId !== null && !this.closed) {
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

const NAV_TIMEOUT_MS = 30000;

// "Real top-level navigation, wait for tabs.onUpdated 'complete'" — used only by
// WellfoundBackgroundWindow.navigate() above. multipage.ts (Techjobs/ITjobs) has its own
// separate copy and stays untouched per this feature's constraints.
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

// Randomized human-pace delay (the caller supplies its own min/max — this file doesn't own or
// change any of the existing pacing constants) that resolves early-as-an-error if the window
// closes mid-wait. Returns true (closed) instead of throwing so call sites can handle it with a
// plain if-check rather than another try/catch layer.
export async function pacedDelay(win: WellfoundBackgroundWindow, minMs: number, maxMs: number): Promise<boolean> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  try {
    await win.delayOrThrowIfClosed(ms);
    return false;
  } catch {
    return true;
  }
}
