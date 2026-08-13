import { deepenLead } from './api';
import type { DeepenedFields, DeepeningStrategy, DeepeningTarget } from './deepening-strategy';
import { pacedDelay, WellfoundBackgroundWindow, WellfoundBackgroundWindowClosedError } from './wellfound-background-window';

// CLAUDE.md scope D (Wellfound): named + easy to raise once this is validated in practice.
export const WELLFOUND_RUN_CAP = 20;
export const WELLFOUND_CIRCUIT_BREAKER_THRESHOLD = 3;

// Wellfound is known to be anti-bot-aggressive — meaningfully slower/more cautious pacing
// than the 1.5-3s used for the plain-fetch strategy (deepen.ts). Exported so
// wellfound-pagination.ts can reuse the exact same pace for its list-page walk instead of
// inventing a second Wellfound pacing constant.
export const MIN_TAB_DELAY_MS = 4000;
export const MAX_TAB_DELAY_MS = 8000;
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
 * Runs ONE dedicated, minimized, unfocused popup window for the whole run (WellfoundBackgroundWindow,
 * shared with wellfound-pagination.ts) — never the manager's active window/tab — and reuses its
 * single tab across every lead by navigating it, the same tab-reuse pattern multipage.ts
 * already uses for Techjobs pagination.
 */
export class TabDeepening implements DeepeningStrategy {
  private readonly win = new WellfoundBackgroundWindow('deepening');

  async deepenOne(target: DeepeningTarget): Promise<DeepenedFields | null> {
    await this.win.navigate(target.source_url);
    await sleep(CONTENT_SCRIPT_SETTLE_MS);

    const res = await Promise.race<ExtractResponse>([
      this.win.sendMessage<ExtractResponse>({ type: 'EXTRACT_WELLFOUND_DETAIL' }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Extraction timed out.')), EXTRACT_TIMEOUT_MS);
      }),
    ]);

    return res?.ok && res.detail ? res.detail : null;
  }

  get wasClosedByUser(): boolean {
    return this.win.wasClosedByUser;
  }

  // Exposes the shared window's interruptible human-pace delay without leaking the window
  // instance itself outside this class.
  pacedDelay(minMs: number, maxMs: number): Promise<boolean> {
    return pacedDelay(this.win, minMs, maxMs);
  }

  // Closes the dedicated window. Call once at the end of a run (success, cap, circuit
  // breaker, or closure already detected) — never leave an extra background window open.
  async close(): Promise<void> {
    await this.win.close();
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
  // True if the run didn't finish all targets, for either reason below.
  stoppedEarly: boolean;
  // True specifically when the background window was closed mid-run (as opposed to the
  // circuit breaker tripping) — lets callers give a more accurate "interrupted, resume via X"
  // message instead of the generic "possible bot-detection block" one.
  interrupted: boolean;
}

/**
 * Sequential, human-paced, capped at WELLFOUND_RUN_CAP leads per run. Stops immediately (the
 * circuit breaker) after WELLFOUND_CIRCUIT_BREAKER_THRESHOLD consecutive failures rather than
 * continuing to hammer what's likely a blocked session — surfaced to the caller via
 * `stoppedEarly`, never silently swallowed (NFR-12/13). Also stops cleanly (and distinctly,
 * via `interrupted`) if the manager closes the dedicated background window mid-run — whatever
 * was already saved stays saved; there's no separate "resume" state to track here since the
 * next deepen attempt (a fresh parse, or the dashboard's Enrich button) simply retries whatever
 * lead is still missing a description.
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
  let interrupted = false;
  let processed = 0;

  try {
    for (let i = 0; i < capped.length; i++) {
      const target = capped[i];
      let detail: DeepenedFields | null = null;
      let saveFailed = false;
      let closed = false;

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
      } catch (err) {
        if (err instanceof WellfoundBackgroundWindowClosedError || strategy.wasClosedByUser) {
          closed = true;
        } else if (detail) {
          // deepenOne() succeeded and the backend PATCH failed — swallow, counted as a
          // failure below (one bad lead must not abort the run).
          saveFailed = true;
        }
        // Otherwise deepenOne() itself failed and `detail` is still its initial null —
        // swallowed the same way, also counted as a failure below.
      }

      if (closed) {
        stoppedEarly = true;
        interrupted = true;
        onProgress({ current: processed, total: capped.length, succeeded, stoppedEarly: true });
        break;
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
        if (await strategy.pacedDelay(MIN_TAB_DELAY_MS, MAX_TAB_DELAY_MS)) {
          stoppedEarly = true;
          interrupted = true;
          break;
        }
      }
    }
  } finally {
    await strategy.close();
  }

  return { processed, succeeded, stoppedEarly, interrupted };
}
