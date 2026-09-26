import { deepenLead } from './api';
import type { DeepenedFields, DeepeningStrategy, DeepeningTarget } from './deepening-strategy';
import { IndeedBackgroundWindow, IndeedBackgroundWindowClosedError, pacedDelay } from './indeed-background-window';
import {
  INDEED_AUTO_BATCH_PAUSE_MAX_MS,
  INDEED_AUTO_BATCH_PAUSE_MIN_MS,
  INDEED_CIRCUIT_BREAKER_THRESHOLD,
  MAX_INDEED_TAB_DELAY_MS,
  MIN_INDEED_TAB_DELAY_MS,
} from './indeed-pagination';

// DI-2966 follow-up (24.09): live testing confirmed the original assumption behind Indeed
// deepening was wrong. FetchDeepening (a plain background fetch(), deepen.ts) was reused for
// Indeed on the theory that the dashboard's manual Enrich button "worked" against it — that
// theory is now known to be unreliable/coincidental. Confirmed instead: EVERY fetch() to
// https://ua.indeed.com/viewjob?jk=... returns HTTP 403 (15/15 in a real test) — the exact same
// class of anti-bot block already documented for Wellfound's DataDome (wellfound-deepen.ts) and
// for a plain curl against Indeed's own LIST page in the original spike. Indeed's anti-bot
// evidently distinguishes real browser navigations from programmatic fetch/XHR and blocks the
// latter, at least for this endpoint.
//
// This file is the Indeed equivalent of wellfound-deepen.ts: a real, dedicated background browser
// tab (IndeedBackgroundWindow, already built for indeed-pagination.ts) navigates to each lead's
// actual source_url, waits for the page's own scripts to run, then reads back the resulting
// embedded data via the content script (indeed-detail-extract.ts) — never a plain fetch.
//
// Two deliberate simplifications versus TabDeepening (wellfound-deepen.ts), both because
// Indeed's own detail-page failure modes are unconfirmed (unlike Wellfound's, which were tested
// against a live 404):
//   1. No distinct "definitive 404, don't count toward the circuit breaker" path — every
//      extraction failure (timeout, block, or a genuinely removed posting) counts as an ordinary
//      failure here. See content.ts's pollForIndeedDetail for the same reasoning.
//   2. Only `description` is ever sent to the backend (see deepenOne's DeepenedFields callers
//      below) — company/company_website/published_at stay whatever the list parse already set,
//      per this task's own scope (Indeed has no external company_website at all — see
//      dashboard-page.ts's Website column note).
//
// Pacing/circuit-breaker constants are NOT reinvented here — reused directly from
// indeed-pagination.ts (MIN/MAX_INDEED_TAB_DELAY_MS, INDEED_CIRCUIT_BREAKER_THRESHOLD,
// INDEED_AUTO_BATCH_PAUSE_MIN/MAX_MS), the same "one shared pair of Indeed tunables" stance
// wellfound-deepen.ts takes for its own Wellfound constants.

// After navigation "complete", give the content script's onMessage listener a moment to attach
// before messaging it — same race wellfound-deepen.ts's CONTENT_SCRIPT_SETTLE_MS documents. The
// content script's own poll (content.ts's INDEED_POLL_TIMEOUT_MS, up to 15s) covers hydration
// timing beyond that.
const CONTENT_SCRIPT_SETTLE_MS = 1000;
// Comfortably above the content script's own 15s poll timeout — a backstop for truly broken
// channels (tab crashed, no listener at all), not the primary timeout. Same value/reasoning as
// wellfound-deepen.ts's EXTRACT_TIMEOUT_MS.
const EXTRACT_TIMEOUT_MS = 20000;

// Mirrors WELLFOUND_RUN_CAP — named + easy to raise once validated in practice. Same value (30)
// purely because there's no evidence yet to pick a different number, not a claim that Indeed's
// actual tolerance matches Wellfound's.
export const INDEED_DEEPEN_RUN_CAP = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ExtractResponse {
  ok: boolean;
  detail?: DeepenedFields;
  error?: string;
}

/**
 * Real-tab deepening strategy for Indeed — the DI-2966 follow-up replacement for the broken
 * FetchDeepening path. Runs ONE dedicated, minimized, unfocused popup window for the whole run
 * (IndeedBackgroundWindow, shared with indeed-pagination.ts) — never the manager's active
 * window/tab — and reuses its single tab across every lead by navigating it, same tab-reuse
 * pattern as Wellfound's TabDeepening and Techjobs' multipage.ts.
 */
export class IndeedTabDeepening implements DeepeningStrategy {
  private readonly win = new IndeedBackgroundWindow('indeed-deepening');
  // Superset of "failed" reasons for ANY non-ok extraction result — used only for visibility
  // (console.error), never consulted for circuit-breaker/retry decisions. See this file's header
  // comment for why there's no separate "definitive not-found" subset the way Wellfound's
  // lastNotFound is (Indeed's removed-posting behavior is unconfirmed).
  private lastFailureReason: string | null = null;

  async deepenOne(target: DeepeningTarget): Promise<DeepenedFields | null> {
    this.lastFailureReason = null;
    await this.win.navigate(target.source_url);
    await sleep(CONTENT_SCRIPT_SETTLE_MS);

    const res = await Promise.race<ExtractResponse>([
      this.win.sendMessage<ExtractResponse>({ type: 'EXTRACT_INDEED_DETAIL' }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Extraction timed out.')), EXTRACT_TIMEOUT_MS);
      }),
    ]);

    if (!res?.ok) {
      this.lastFailureReason = res?.error ?? 'Extraction failed for an unknown reason.';
    }

    return res?.ok && res.detail ? res.detail : null;
  }

  get wasClosedByUser(): boolean {
    return this.win.wasClosedByUser;
  }

  get lastFailure(): string | null {
    return this.lastFailureReason;
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

export interface IndeedDeepenProgress {
  current: number;
  total: number;
  succeeded: number;
  stoppedEarly: boolean;
}

export interface IndeedDeepenResult {
  processed: number;
  succeeded: number;
  stoppedEarly: boolean;
  // True specifically when the background window was closed mid-run (as opposed to the circuit
  // breaker tripping) — same distinction as Wellfound's interrupted flag.
  interrupted: boolean;
}

/**
 * Sequential, human-paced, capped at INDEED_DEEPEN_RUN_CAP leads per run — the Indeed equivalent
 * of wellfound-deepen.ts's deepenWellfoundLeads, minus the definitive-404 exemption (see this
 * file's header comment). Stops immediately (the circuit breaker) after
 * INDEED_CIRCUIT_BREAKER_THRESHOLD consecutive failures, and stops cleanly (via `interrupted`)
 * if the manager closes the dedicated background window mid-run — same NFR-12/13 "no silent
 * failure" stance as every other deepening flow in this codebase.
 *
 * Only `description` is ever PATCHed to the backend (see this file's header comment) —
 * company/company_website/published_at from `detail` are deliberately never spread into the
 * deepenLead() call, unlike Wellfound's equivalent loop.
 */
export async function deepenIndeedLeads(
  targets: DeepeningTarget[],
  onProgress: (progress: IndeedDeepenProgress) => void,
): Promise<IndeedDeepenResult> {
  const capped = targets.slice(0, INDEED_DEEPEN_RUN_CAP);
  const strategy = new IndeedTabDeepening();

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
          // Only `description` — see this file's header comment.
          await deepenLead(target.id, { description: detail.description });
        }
      } catch (err) {
        if (err instanceof IndeedBackgroundWindowClosedError || strategy.wasClosedByUser) {
          closed = true;
        } else if (detail) {
          // deepenOne() succeeded and the backend PATCH failed — swallow, counted as a failure
          // below (one bad lead must not abort the run). Same reasoning as Wellfound's identical
          // branch: a save failure is transient/our-own-backend, not a definitive Indeed-side
          // failure.
          saveFailed = true;
          console.error(`[Indeed deepen] Save failed for lead ${target.id} (${target.source_url}):`, err instanceof Error ? err.message : String(err));
        } else {
          console.error(`[Indeed deepen] Failed for lead ${target.id} (${target.source_url}):`, err instanceof Error ? err.message : String(err));
        }
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
        if (!detail && !saveFailed && strategy.lastFailure) {
          console.error(`[Indeed deepen] Failed for lead ${target.id} (${target.source_url}):`, strategy.lastFailure);
        }
      }

      if (consecutiveFailures >= INDEED_CIRCUIT_BREAKER_THRESHOLD) {
        stoppedEarly = true;
        onProgress({ current: processed, total: capped.length, succeeded, stoppedEarly: true });
        break;
      }

      onProgress({ current: processed, total: capped.length, succeeded, stoppedEarly: false });
      strategy.setProgress(`${processed}/${capped.length} lead(s) processed, ${succeeded} succeeded`);

      if (i < capped.length - 1) {
        if (await strategy.pacedDelay(MIN_INDEED_TAB_DELAY_MS, MAX_INDEED_TAB_DELAY_MS)) {
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

export interface IndeedAutoDeepenWaveProgress {
  waveIndex: number; // 1-based
  waveCount: number;
  current: number; // within the current wave
  total: number; // current wave's size (<= INDEED_DEEPEN_RUN_CAP)
  overallProcessed: number;
  overallTotal: number;
  succeeded: number;
}

export interface IndeedAutoDeepenResult {
  processed: number;
  succeeded: number;
  waves: number;
  stoppedEarly: boolean;
  interrupted: boolean;
}

/**
 * Wraps deepenIndeedLeads the same way wellfound-deepen.ts's runWellfoundAutoDeepenWaves wraps
 * deepenWellfoundLeads: automated multi-page Indeed pagination (indeed-pagination.ts) can surface
 * far more new leads in one run than INDEED_DEEPEN_RUN_CAP handles on its own — this chunks
 * targets into capped waves, runs each through the existing, unchanged deepenIndeedLeads (so
 * per-wave behavior stays exactly as already validated), and pauses between waves using Indeed's
 * own batch-pause constants (INDEED_AUTO_BATCH_PAUSE_MIN/MAX_MS, already established in
 * indeed-pagination.ts — reused here, not reinvented).
 *
 * Simpler than Wellfound's version: this is only ever called from the side panel today (App.tsx),
 * never from the background service worker, so it doesn't need Wellfound's
 * waitKeepingServiceWorkerAlive treatment for its inter-wave pause — a plain sleep is enough. If
 * a future caller (e.g. the dashboard's bulk Enrich button, background.ts) drives this from the
 * service worker, it would need that same keepalive treatment first — see this task's own report
 * for why that button isn't repointed here yet.
 *
 * Stops the whole sequence the moment one wave itself stops early — same reasoning as Wellfound's
 * version: a circuit breaker trip or a closed window means starting another wave right away is
 * the wrong move. Whatever succeeded across already-completed waves stays saved either way.
 */
export async function runIndeedAutoDeepenWaves(
  targets: DeepeningTarget[],
  onProgress: (progress: IndeedAutoDeepenWaveProgress) => void,
): Promise<IndeedAutoDeepenResult> {
  const waveCount = Math.ceil(targets.length / INDEED_DEEPEN_RUN_CAP);
  let processed = 0;
  let succeeded = 0;
  let stoppedEarly = false;
  let interrupted = false;
  let wavesRun = 0;

  for (let w = 0; w < waveCount; w++) {
    const waveTargets = targets.slice(w * INDEED_DEEPEN_RUN_CAP, (w + 1) * INDEED_DEEPEN_RUN_CAP);
    wavesRun++;
    const processedBeforeWave = processed;
    const succeededBeforeWave = succeeded;

    const result = await deepenIndeedLeads(waveTargets, (progress) => {
      onProgress({
        waveIndex: w + 1,
        waveCount,
        current: progress.current,
        total: progress.total,
        overallProcessed: processedBeforeWave + progress.current,
        overallTotal: targets.length,
        succeeded: succeededBeforeWave + progress.succeeded,
      });
    });

    processed += result.processed;
    succeeded += result.succeeded;

    if (result.interrupted) {
      interrupted = true;
      stoppedEarly = true;
      break;
    }
    if (result.stoppedEarly) {
      stoppedEarly = true;
      break;
    }

    const isLastWave = w === waveCount - 1;
    if (!isLastWave) {
      await sleep(INDEED_AUTO_BATCH_PAUSE_MIN_MS + Math.random() * (INDEED_AUTO_BATCH_PAUSE_MAX_MS - INDEED_AUTO_BATCH_PAUSE_MIN_MS));
    }
  }

  return { processed, succeeded, waves: wavesRun, stoppedEarly, interrupted };
}
