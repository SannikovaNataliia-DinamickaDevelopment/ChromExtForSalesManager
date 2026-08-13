import { setLeadHiringContact } from './api';
import type { DeepeningTarget } from './deepening-strategy';
import {
  MAX_TAB_DELAY_MS,
  MIN_TAB_DELAY_MS,
  TabDeepening,
  WELLFOUND_CIRCUIT_BREAKER_THRESHOLD,
  WELLFOUND_RUN_CAP,
} from './wellfound-deepen';
import { WellfoundBackgroundWindowClosedError } from './wellfound-background-window';

export interface ContactBackfillProgress {
  current: number;
  total: number;
  found: number;
  stoppedEarly: boolean;
}

export interface ContactBackfillResult {
  processed: number;
  found: number;
  notSpecified: number;
  // Definitive 404s, timeouts/blocks, and save failures the run couldn't resolve either way —
  // left as 'not_checked' for a later run to retry, never counted as a resolved state.
  unresolved: number;
  stoppedEarly: boolean;
  interrupted: boolean;
}

/**
 * Dedicated backfill for leads whose hiring_contact_status is still 'not_checked' — typically
 * leads deepened before this field existed, or ones the opportunistic save inside
 * deepenWellfoundLeads (wellfound-deepen.ts) failed to write for. Callers MUST pre-filter
 * targets to only hiring_contact_status === 'not_checked' leads — this function doesn't
 * re-check that itself — so a run (even run repeatedly) can never re-visit a lead already
 * resolved to 'found' or 'not_specified'.
 *
 * Reuses TabDeepening.deepenOne() purely for its extraction (navigate + poll + read
 * DeepenedFields.hiring_contact) — deepenOne() itself has no side effects, so this never
 * touches description/company/company_website/enrichment_error, only ever writing
 * hiring_contact_* via setLeadHiringContact. Same window/pacing/cap/circuit-breaker machinery
 * as normal Wellfound deepening (WELLFOUND_RUN_CAP, WELLFOUND_CIRCUIT_BREAKER_THRESHOLD,
 * MIN/MAX_TAB_DELAY_MS) — CLAUDE.md-style "reuse unless there's a good reason not to."
 *
 * A definitive 404 (posting removed/expired) or a timeout/block leaves the lead's
 * hiring_contact_status untouched ('not_checked') — we didn't get a chance to look, so there's
 * nothing to record either way. A 404 doesn't count toward the circuit breaker (same reasoning
 * as deepenWellfoundLeads); a timeout/block does.
 */
export async function backfillWellfoundContact(
  targets: DeepeningTarget[],
  onProgress: (progress: ContactBackfillProgress) => void,
): Promise<ContactBackfillResult> {
  const capped = targets.slice(0, WELLFOUND_RUN_CAP);
  const strategy = new TabDeepening();

  let found = 0;
  let notSpecified = 0;
  let unresolved = 0;
  let consecutiveFailures = 0;
  let stoppedEarly = false;
  let interrupted = false;
  let processed = 0;

  try {
    for (let i = 0; i < capped.length; i++) {
      const target = capped[i];
      let detail;
      let closed = false;

      try {
        detail = await strategy.deepenOne(target);
      } catch (err) {
        if (err instanceof WellfoundBackgroundWindowClosedError || strategy.wasClosedByUser) {
          closed = true;
        }
        detail = null;
      }

      if (closed) {
        stoppedEarly = true;
        interrupted = true;
        onProgress({ current: processed, total: capped.length, found, stoppedEarly: true });
        break;
      }

      const notFoundReason = strategy.lastNotFound;
      if (!detail && notFoundReason) {
        // Definitive 404 — can't check, leave 'not_checked' as-is. Doesn't touch
        // consecutiveFailures, same reasoning as deepenWellfoundLeads.
        processed++;
        unresolved++;
        onProgress({ current: processed, total: capped.length, found, stoppedEarly: false });
        strategy.setProgress(`${processed}/${capped.length} lead(s) checked, ${found} contact(s) found`);
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

      if (!detail) {
        // Timeout/possible block — genuinely couldn't check this time, counts toward the
        // circuit breaker same as a normal deepen failure.
        unresolved++;
        consecutiveFailures++;
      } else {
        consecutiveFailures = 0;
        try {
          if (detail.hiring_contact === null) {
            await setLeadHiringContact(target.id, { status: 'not_specified' });
            notSpecified++;
          } else if (detail.hiring_contact) {
            await setLeadHiringContact(target.id, { status: 'found', ...detail.hiring_contact });
            found++;
          } else {
            // Shouldn't happen — TabDeepening's extraction always sets hiring_contact — but if
            // it's ever undefined, there's nothing resolved to save; leave 'not_checked'.
            unresolved++;
          }
        } catch {
          // Save failed — leave 'not_checked' for a later run; the page read fine, only the
          // write failed, so this isn't a strategy failure.
          unresolved++;
        }
      }

      if (consecutiveFailures >= WELLFOUND_CIRCUIT_BREAKER_THRESHOLD) {
        stoppedEarly = true;
        onProgress({ current: processed, total: capped.length, found, stoppedEarly: true });
        break;
      }

      onProgress({ current: processed, total: capped.length, found, stoppedEarly: false });
      strategy.setProgress(`${processed}/${capped.length} lead(s) checked, ${found} contact(s) found`);

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

  return { processed, found, notSpecified, unresolved, stoppedEarly, interrupted };
}
