// Indeed-only "dedicated popup window" lifecycle — DI-2966, Priority #1 job source after
// Wellfound (11.09 team call). 24.09 follow-up: unlike WellfoundBackgroundWindow, this window is
// now visible and focused rather than minimized/unfocused — an experimental response to a real
// Cloudflare Turnstile challenge hitting Indeed's automated page loads; see ensureTab()'s own
// comment for why and how unconfirmed that is. Still deliberately a separate copy of
// wellfound-background-window.ts's WellfoundBackgroundWindow, not a shared/generalized class,
// and wellfound-background-window.ts itself stays completely untouched. Three reasons, matching
// this codebase's own existing precedent (multipage.ts stays a full separate copy of its own
// navigate-and-wait/settle-delay logic rather than sharing wellfound-pagination.ts's, specifically
// because Techjobs/ITjobs' and Wellfound's behavior diverges meaningfully):
//   1. User-facing leak: WellfoundBackgroundWindowClosedError's message is the literal string
//      "The Wellfound background window was closed before this run finished." — reusing that
//      class as-is would show Wellfound's name in an Indeed run's error/summary text, which is
//      actively misleading, not just a naming nitpick.
//   2. Reader confusion: `catch (err) { if (err instanceof WellfoundBackgroundWindowClosedError) }`
//      inside an indeed-*.ts file reads like a copy-paste bug to anyone maintaining this later.
//   3. The class is small (~250 lines, much of it comments) and has zero Wellfound-specific
//      BEHAVIOR baked in (no branching on site) — only naming/messaging. Duplicating it is cheap;
//      generalizing it would require either touching the already-battle-tested Wellfound file
//      (explicitly out of scope for this task) or accepting the misleading text from point 1.
//
// Most of the mechanics below (closure detection via chrome.windows.onRemoved, overlay
// re-injection with retry, paced/interruptible delay) are intentionally identical to
// WellfoundBackgroundWindow — see that file for the full reasoning behind each piece. The one
// deliberate divergence is the popup's own visibility/focus state (see ensureTab()) — everything
// else is naming/comments only.

// --- Human bot-check handling (02.10) ---------------------------------------------------------
// Cloudflare's "tick the checkbox" check shows up on some Indeed page loads. It is NEVER solved by
// the extension: the run pauses, the window is brought to the front, and the manager ticks it
// herself; the run resumes once the page no longer shows the check. Live evidence (02.10 deepen
// console): 3 leads timed out while a check was up, and a 4th failed with "message channel closed"
// — the page reloading right after the manager ticked the box mid-extraction.

// How long to wait for the manager to complete a check before giving up on that page. Raised
// 06.10 from 3 to 10 min: with 3 min, a check missed while she was away failed three leads in a
// row and the circuit breaker ended a Chile deepening run with 21 leads untouched.
export const INDEED_HUMAN_CHECK_WAIT_MS = 600_000;
const HUMAN_CHECK_POLL_MS = 2_000;

type HumanCheckListener = (waiting: boolean) => void;
const humanCheckListeners = new Set<HumanCheckListener>();

// The side panel subscribes once to show a prominent "tick the check in the Indeed window" notice
// while any Indeed run (pagination or deepening) is waiting on one.
export function subscribeIndeedHumanCheck(listener: HumanCheckListener): () => void {
  humanCheckListeners.add(listener);
  return () => humanCheckListeners.delete(listener);
}

function notifyHumanCheck(waiting: boolean): void {
  for (const listener of humanCheckListeners) listener(waiting);
}

// Out-of-panel alerts while a check is waiting (06.10): a system notification (stays until
// dismissed; clicking it raises the Indeed window) and a red "!" badge on the toolbar icon. All
// best-effort — the side panel banner (subscribeIndeedHumanCheck) is still the primary signal.
const HUMAN_CHECK_NOTIFICATION_ID = 'indeed-human-check';

function showHumanCheckAlert(): void {
  try {
    void chrome.action?.setBadgeBackgroundColor({ color: '#F2555A' });
    void chrome.action?.setBadgeText({ text: '!' });
  } catch {
    // no toolbar action — notification + panel banner still show
  }
  try {
    chrome.notifications?.create(HUMAN_CHECK_NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon/alert-128.png'),
      title: 'Indeed: a bot check is waiting for you',
      message:
        `Tick the Cloudflare checkbox in the Indeed window — the run is paused and continues on its own ` +
        `(waits up to ${INDEED_HUMAN_CHECK_WAIT_MS / 60_000} min). Click here to open that window.`,
      requireInteraction: true,
      priority: 2,
    });
  } catch {
    // notifications unavailable — badge + panel banner still show
  }
}

function clearHumanCheckAlert(): void {
  try {
    void chrome.action?.setBadgeText({ text: '' });
  } catch {
    // ignore
  }
  try {
    chrome.notifications?.clear(HUMAN_CHECK_NOTIFICATION_ID);
  } catch {
    // ignore
  }
}

interface DetectChallengeResponse {
  ok?: boolean;
  challenge?: string | null;
}

// Is a bot check showing in the window right now? A messaging failure (page mid-reload, content
// script not attached yet) answers "unknown" as null.
async function probeChallenge(win: IndeedBackgroundWindow): Promise<string | null | undefined> {
  try {
    const res = await win.sendMessage<DetectChallengeResponse>({ type: 'DETECT_BOT_CHALLENGE' });
    return res?.challenge ?? null;
  } catch (err) {
    if (err instanceof IndeedBackgroundWindowClosedError) throw err;
    return undefined;
  }
}

/**
 * Called once a page is known (or suspected) to be showing a bot check. Brings the window to the
 * front and polls until the check is gone — the manager ticked it and the page reloaded — or
 * INDEED_HUMAN_CHECK_WAIT_MS passes. Returns true when the check cleared (caller re-reads the
 * page), false on timeout. Throws IndeedBackgroundWindowClosedError if the window is closed.
 */
export async function waitForHumanCheck(win: IndeedBackgroundWindow): Promise<boolean> {
  notifyHumanCheck(true);
  showHumanCheckAlert();
  const onNotificationClick = (id: string) => {
    if (id === HUMAN_CHECK_NOTIFICATION_ID) void win.bringToFront();
  };
  chrome.notifications?.onClicked.addListener(onNotificationClick);
  await win.bringToFront();
  const deadline = Date.now() + INDEED_HUMAN_CHECK_WAIT_MS;
  try {
    while (Date.now() < deadline) {
      await win.delayOrThrowIfClosed(HUMAN_CHECK_POLL_MS);
      const challenge = await probeChallenge(win);
      // null = content script answered and sees no check; undefined = page still reloading.
      if (challenge === null) return true;
    }
    return false;
  } finally {
    chrome.notifications?.onClicked.removeListener(onNotificationClick);
    clearHumanCheckAlert();
    notifyHumanCheck(false);
  }
}

// Convenience for callers that just loaded a page: if a check is up, wait for the manager.
// Returns false only when a check was up and wasn't completed in time.
export async function passHumanCheckIfShown(win: IndeedBackgroundWindow): Promise<boolean> {
  const challenge = await probeChallenge(win);
  if (!challenge) return true;
  console.warn(`[Indeed] Bot check shown (${challenge}) — waiting for the manager to complete it.`);
  return waitForHumanCheck(win);
}

export class IndeedBackgroundWindowClosedError extends Error {
  constructor() {
    super('The Indeed background window was closed before this run finished.');
    this.name = 'IndeedBackgroundWindowClosedError';
  }
}

interface BackgroundMessageResponse {
  ok?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// See showOverlayWithRetry()'s comment for why this needs retrying at all — same race as
// WellfoundBackgroundWindow's identical constant.
const OVERLAY_SEND_MAX_ATTEMPTS = 5;
const OVERLAY_SEND_RETRY_DELAY_MS = 300;

export class IndeedBackgroundWindow {
  private windowId: number | null = null;
  private tabId: number | null = null;
  private closed = false;
  private closedListener: ((windowId: number) => void) | null = null;
  // Shown via content.ts's SHOW_BACKGROUND_OVERLAY after every navigation — short label
  // distinguishing what's running for the message text (currently only 'indeed-pagination').
  constructor(private readonly overlayLabel: string) {}

  // Live running-count text folded into the overlay's warning message — same contract as
  // WellfoundBackgroundWindow.setProgress.
  private progressText = '';

  setProgress(text: string): void {
    this.progressText = text;
  }

  get wasClosedByUser(): boolean {
    return this.closed;
  }

  private async ensureTab(): Promise<number> {
    if (this.closed) {
      throw new IndeedBackgroundWindowClosedError();
    }
    if (this.tabId !== null) return this.tabId;

    // 24.09 follow-up — EXPERIMENTAL, unconfirmed: a real Cloudflare Turnstile challenge is
    // hitting this window on every Indeed page load. WellfoundBackgroundWindow's own
    // minimized+unfocused pattern (no visible rendering, no focus, no human interaction) is a
    // known Cloudflare bot-detection signal, so this is deliberately the opposite — a normal,
    // visible, focused popup — as a live experiment to see whether it reduces/avoids the
    // challenge. NOT a confirmed fix; needs a real re-test to know either way. Modest fixed size
    // (not the whole screen) since Nataliia will actually see this window while a run is active.
    // Deliberately Indeed-only: WellfoundBackgroundWindow (wellfound-background-window.ts) stays
    // minimized/unfocused, untouched — that pattern is already battle-tested against Wellfound
    // specifically and this experiment must not risk it.
    const win = await chrome.windows.create({
      url: 'about:blank',
      type: 'popup',
      state: 'normal',
      focused: true,
      width: 450,
      height: 700,
    });

    this.windowId = win.id ?? null;
    let tabId = win.tabs?.[0]?.id;
    if (tabId === undefined && this.windowId !== null) {
      const tabs = await chrome.tabs.query({ windowId: this.windowId });
      tabId = tabs[0]?.id;
    }
    if (tabId === undefined) {
      throw new Error('Could not create a background window for Indeed.');
    }
    this.tabId = tabId;

    // Fires whether the manager closes the window itself or closes its one tab — same
    // "notify after the fact, since Chrome gives no way to block/confirm closure" approach as
    // WellfoundBackgroundWindow.
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
  // the freshly-loaded page. Throws IndeedBackgroundWindowClosedError if the window is gone
  // either before or immediately after the navigation.
  //
  // Note for Indeed specifically: a navigation that lands the tab on secure.indeed.com (the
  // sign-in wall — see indeed-pagination.ts's isIndeedSignInWall) will make the overlay send
  // below fail every retry, since the content script's manifest matches only www.indeed.com and
  // is never injected there. That's expected and harmless — showOverlayWithRetry already treats
  // a failed overlay injection as best-effort, never fatal to the real work.
  async navigate(url: string): Promise<void> {
    const tabId = await this.ensureTab();
    await navigateAndWaitForLoad(tabId, url);
    if (this.closed) {
      throw new IndeedBackgroundWindowClosedError();
    }
    await this.showOverlayWithRetry(tabId);
  }

  // chrome.tabs.onUpdated reporting 'complete' means the navigation itself is done, but the
  // manifest-declared content script can still take a moment longer to actually attach and
  // register its onMessage listener — same race WellfoundBackgroundWindow guards against.
  private async showOverlayWithRetry(tabId: number): Promise<void> {
    for (let attempt = 0; attempt < OVERLAY_SEND_MAX_ATTEMPTS; attempt++) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'SHOW_BACKGROUND_OVERLAY',
          label: this.overlayLabel,
          progress: this.progressText,
        });
        return;
      } catch {
        if (attempt < OVERLAY_SEND_MAX_ATTEMPTS - 1) {
          await sleep(OVERLAY_SEND_RETRY_DELAY_MS);
        }
      }
    }
    // Best-effort even after exhausting retries — a failed overlay injection must never abort
    // real work. The overlay is a visual warning, not a safety mechanism.
  }

  // Raise the window and flash its taskbar entry so the manager notices a bot check waiting on
  // her. Best-effort.
  async bringToFront(): Promise<void> {
    if (this.closed || this.windowId === null) return;
    try {
      await chrome.windows.update(this.windowId, { focused: true, drawAttention: true, state: 'normal' });
    } catch {
      // Window gone or not focusable — the side panel notice still shows.
    }
  }

  // Re-sends the current overlay text to the tab's CURRENTLY loaded page, without navigating —
  // lets a caller update the "don't close this window" message mid-wait (e.g. an inter-batch
  // cooldown). Best-effort, same as showOverlayWithRetry itself.
  async refreshOverlay(): Promise<void> {
    if (this.closed || this.tabId === null) return;
    await this.showOverlayWithRetry(this.tabId);
  }

  async sendMessage<T extends BackgroundMessageResponse>(message: unknown): Promise<T> {
    if (this.closed || this.tabId === null) {
      throw new IndeedBackgroundWindowClosedError();
    }
    return chrome.tabs.sendMessage(this.tabId, message) as Promise<T>;
  }

  // Used by indeed-pagination.ts to read the tab's post-navigation URL — both for the sign-in
  // wall check (isIndeedSignInWall) and as a defensive secondary "no more pages" signal. Returns
  // null on any failure, including a closed window.
  async getTabUrl(): Promise<string | null> {
    if (this.tabId === null || this.closed) return null;
    try {
      const tab = await chrome.tabs.get(this.tabId);
      return tab.url ?? null;
    } catch {
      return null;
    }
  }

  // Human-pace delay that's abortable by the window closing mid-wait — same rationale as
  // WellfoundBackgroundWindow.delayOrThrowIfClosed.
  async delayOrThrowIfClosed(ms: number): Promise<void> {
    if (this.closed) {
      throw new IndeedBackgroundWindowClosedError();
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        resolve();
      }, ms);
      const poll = setInterval(() => {
        if (this.closed) {
          clearTimeout(timer);
          clearInterval(poll);
          reject(new IndeedBackgroundWindowClosedError());
        }
      }, 250);
    });
  }

  // Closes the dedicated window. Call once at the end of a run — never leave an extra
  // background window open. Safe to call even when the window is already gone.
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

// "Real top-level navigation, wait for tabs.onUpdated 'complete'" — Indeed-scoped copy of
// WellfoundBackgroundWindow's identical helper (and multipage.ts's own separate copy before
// that). Kept duplicated rather than shared, consistent with this file's header comment.
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

// Randomized human-pace delay, abortable by the window closing mid-wait — Indeed-scoped copy of
// WellfoundBackgroundWindow's pacedDelay. The caller supplies its own min/max (see
// indeed-pagination.ts's Indeed-specific constants — deliberately NOT Wellfound's MIN/MAX_TAB_DELAY_MS).
export async function pacedDelay(win: IndeedBackgroundWindow, minMs: number, maxMs: number): Promise<boolean> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  try {
    await win.delayOrThrowIfClosed(ms);
    return false;
  } catch {
    return true;
  }
}
