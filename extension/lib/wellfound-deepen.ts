import { deepenLead, markLeadEnrichmentError, setLeadHiringContact } from './api';
import type { DeepenedFields, DeepeningStrategy, DeepeningTarget } from './deepening-strategy';
import { pacedDelay, WellfoundBackgroundWindow, WellfoundBackgroundWindowClosedError } from './wellfound-background-window';

// CLAUDE.md scope D (Wellfound): named + easy to raise once this is validated in practice.
export const WELLFOUND_RUN_CAP = 30;
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
  notFound?: boolean;
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
  // Set by the most recent deepenOne() call when EXTRACT_WELLFOUND_DETAIL came back as a
  // definitive "this posting doesn't exist" (Wellfound's own 404 page — see content.ts's
  // WELLFOUND_NOT_FOUND_TITLE) rather than a timeout/possible-block. Reset at the start of
  // every call, so it only ever reflects the outcome of the most recent one.
  private lastNotFoundReason: string | null = null;
  // Bug fix: any non-ok result used to only forward its message when notFound was true —
  // pollForWellfoundDetail()'s own descriptive timeout/possible-block string ("Timed out
  // waiting for job posting data (15s)...") was silently discarded otherwise, leaving the
  // circuit breaker (and everything downstream) with zero information about WHY a lead failed.
  // This captures the message for ANY failed result — lastNotFound above stays the 404-specific
  // subset (still the only thing that exempts a failure from the circuit breaker's count), this
  // is the superset used purely for visibility (console log + markLeadEnrichmentError).
  private lastFailureReason: string | null = null;

  async deepenOne(target: DeepeningTarget): Promise<DeepenedFields | null> {
    this.lastNotFoundReason = null;
    this.lastFailureReason = null;
    await this.win.navigate(target.source_url);
    await sleep(CONTENT_SCRIPT_SETTLE_MS);

    const res = await Promise.race<ExtractResponse>([
      this.win.sendMessage<ExtractResponse>({ type: 'EXTRACT_WELLFOUND_DETAIL' }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Extraction timed out.')), EXTRACT_TIMEOUT_MS);
      }),
    ]);

    if (!res?.ok) {
      this.lastFailureReason = res?.error ?? 'Extraction failed for an unknown reason.';
      if (res?.notFound) {
        this.lastNotFoundReason = this.lastFailureReason;
      }
    }

    return res?.ok && res.detail ? res.detail : null;
  }

  get wasClosedByUser(): boolean {
    return this.win.wasClosedByUser;
  }

  // Non-null only immediately after a deepenOne() call whose failure was a definitive
  // Wellfound 404, not a timeout/possible-block — the caller (deepenWellfoundLeads) uses this
  // to keep that kind of failure out of the circuit breaker's consecutive-failure count.
  get lastNotFound(): string | null {
    return this.lastNotFoundReason;
  }

  // Non-null after any deepenOne() call that returned a non-ok result, for ANY reason
  // (definitive 404, timeout, or possible bot-detection block) — a strict superset of
  // lastNotFound above. Used only for surfacing the reason (console.error + markLeadEnrichmentError);
  // never consulted for circuit-breaker/retry decisions, which stay exactly as they were.
  get lastFailure(): string | null {
    return this.lastFailureReason;
  }

  // Exposes the shared window's interruptible human-pace delay without leaking the window
  // instance itself outside this class.
  pacedDelay(minMs: number, maxMs: number): Promise<boolean> {
    return pacedDelay(this.win, minMs, maxMs);
  }

  // Exposes the shared window's live-progress-text overlay update without leaking the window
  // instance itself outside this class.
  setProgress(text: string): void {
    this.win.setProgress(text);
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
  // Leads that hit a definitive Wellfound 404 (posting removed/expired) — flagged with
  // enrichment_error and skipped, never counted toward stoppedEarly/the circuit breaker. A
  // separate bucket from succeeded/failed so callers can report it distinctly.
  errorFlagged: number;
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
 *
 * A definitive Wellfound 404 (the posting was removed/expired — confirmed via
 * content.ts's WELLFOUND_NOT_FOUND_TITLE check, not a timeout or an ambiguous/blocked page) is
 * NOT a sign of bot detection and must never count toward the circuit breaker: it's flagged via
 * markLeadEnrichmentError and skipped immediately, leaving consecutiveFailures untouched either
 * way (neither incremented nor reset), so a run of otherwise-genuine timeouts/blocks around it
 * isn't masked by an unrelated 404 landing in between.
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
  let errorFlagged = 0;

  try {
    for (let i = 0; i < capped.length; i++) {
      const target = capped[i];
      let detail: DeepenedFields | null = null;
      let saveFailed = false;
      let closed = false;
      // Bug fix: previously nothing captured *why* a lead failed here — deepenOne() itself
      // throwing (e.g. the 20s extraction backstop) had its message discarded the same way
      // TabDeepening's own resolved-but-not-ok case did. Only set on the "deepenOne() itself
      // threw" path; the "resolved but not ok" path's reason lives on strategy.lastFailure
      // instead (read below, after this try/catch) since that one doesn't throw.
      let thrownErrorMessage: string | null = null;

      try {
        detail = await strategy.deepenOne(target);
        if (detail) {
          await deepenLead(target.id, {
            description: detail.description,
            company: detail.company,
            company_website: detail.company_website,
            ...(detail.published_at ? { published_at: detail.published_at } : {}),
          });
          // Opportunistic: the detail page is already loaded, so save the "Hiring contact"
          // section (if this extraction checked for one — see DeepenedFields.hiring_contact) at
          // zero extra cost. Its own try/catch, separate from the block below: a contact-save
          // failure must never turn a lead whose description/company/website already saved fine
          // into a counted failure (saveFailed) or retroactively affect the circuit breaker.
          if (detail.hiring_contact !== undefined) {
            try {
              await setLeadHiringContact(
                target.id,
                detail.hiring_contact === null
                  ? { status: 'not_specified' }
                  : { status: 'found', ...detail.hiring_contact },
              );
            } catch {
              // Swallow — see comment above. A future backfill run picks this lead up again
              // since hiring_contact_status stays 'not_checked' when this write never landed.
            }
          }
        }
      } catch (err) {
        if (err instanceof WellfoundBackgroundWindowClosedError || strategy.wasClosedByUser) {
          closed = true;
        } else if (detail) {
          // deepenOne() succeeded and the backend PATCH failed — swallow, counted as a
          // failure below (one bad lead must not abort the run). Logged (not persisted to
          // enrichment_error): a save failure is a transient/our-own-backend problem, not a
          // "definitive, non-retriable" Wellfound-side failure, so it shouldn't stop this lead
          // from being auto-retried like enrichment_error would.
          saveFailed = true;
          console.error(`[Wellfound deepen] Save failed for lead ${target.id} (${target.source_url}):`, err instanceof Error ? err.message : String(err));
        } else {
          // deepenOne() itself threw (e.g. the 20s extraction backstop, or navigate() failing) —
          // previously this message was discarded entirely; captured here so the generic-failure
          // handling below (after this try/catch) can log it and record it via
          // markLeadEnrichmentError, same as TabDeepening's own resolved-but-not-ok case.
          thrownErrorMessage = err instanceof Error ? err.message : String(err);
        }
      }

      if (closed) {
        stoppedEarly = true;
        interrupted = true;
        onProgress({ current: processed, total: capped.length, succeeded, stoppedEarly: true });
        break;
      }

      const notFoundReason = strategy.lastNotFound;
      if (!detail && notFoundReason) {
        // Definitive 404 — flag the lead and move on immediately. Deliberately does NOT touch
        // consecutiveFailures (see this function's doc comment) — never counts toward the
        // circuit breaker.
        try {
          await markLeadEnrichmentError(target.id, notFoundReason);
        } catch {
          // Swallow: failing to record the flag must not abort the run — worst case this lead
          // just gets attempted again next time, same as any other unflagged failure would.
        }
        processed++;
        errorFlagged++;
        onProgress({ current: processed, total: capped.length, succeeded, stoppedEarly: false });
        strategy.setProgress(`${processed}/${capped.length} lead(s) processed, ${succeeded} succeeded`);

        if (i < capped.length - 1) {
          if (await strategy.pacedDelay(MIN_TAB_DELAY_MS, MAX_TAB_DELAY_MS)) {
            stoppedEarly = true;
            interrupted = true;
            break;
          }
        }
        continue;
      }

      processed++;

      if (detail && !saveFailed) {
        succeeded++;
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        // Bug fix: extraction failed (not a save failure — that's logged separately above,
        // and deliberately doesn't reach here as enrichment_error, see that branch's comment)
        // and it wasn't a definitive 404 (that's the earlier notFoundReason/continue branch,
        // untouched). Previously this reason — content.ts's own descriptive timeout/possible-
        // block message, or a thrown deepenOne() error — was silently discarded here with no
        // log and nothing recorded on the lead. Now: logged, and recorded via the same
        // markLeadEnrichmentError path the 404 case already uses, so it's visible on the
        // lead's dashboard row/sidebar (Detail: Error, tooltip) instead of blending
        // invisibly into "not detailed" forever. Does NOT touch consecutiveFailures/the
        // circuit breaker above, and does NOT change whether this counts as failed —
        // purely making the existing reason visible.
        if (!detail && !saveFailed) {
          const reason = thrownErrorMessage ?? strategy.lastFailure ?? 'Wellfound deepening failed for an unknown reason.';
          console.error(`[Wellfound deepen] Failed for lead ${target.id} (${target.source_url}):`, reason);
          try {
            await markLeadEnrichmentError(target.id, reason);
          } catch {
            // Swallow — see the 404 branch's identical comment above: failing to record the
            // flag must not abort the run.
          }
        }
      }

      if (consecutiveFailures >= WELLFOUND_CIRCUIT_BREAKER_THRESHOLD) {
        stoppedEarly = true;
        onProgress({ current: processed, total: capped.length, succeeded, stoppedEarly: true });
        break;
      }

      onProgress({ current: processed, total: capped.length, succeeded, stoppedEarly: false });
      strategy.setProgress(`${processed}/${capped.length} lead(s) processed, ${succeeded} succeeded`);

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

  return { processed, succeeded, stoppedEarly, interrupted, errorFlagged };
}
