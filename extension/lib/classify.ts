import { classifyLead } from './api';

// Gemini's free tier is tight for the flash model this backend uses — observed live: only
// 5 requests/minute before a 429 (see backend/src/leads/gemini-classifier.service.ts). 13-15s
// between calls keeps well under that; bump this up if you're seeing frequent unprocessed leads.
const MIN_DELAY_MS = 13000;
const MAX_DELAY_MS = 15000;

// A single 429 could be an ambiguous blip (e.g. a burst right at the per-minute boundary), but
// two in a row is the quota signal: further calls right now are futile, so the run stops
// instead of grinding through every remaining lead for another guaranteed 429.
const CONSECUTIVE_QUOTA_HITS_TO_STOP = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ClassifyTarget {
  id: string;
}

export interface ClassifyProgress {
  current: number;
  total: number;
  unprocessed: number;
  stoppedEarly: boolean;
}

/**
 * CLAUDE.md scope C: sequentially asks the backend to classify each pending lead (has a
 * description, is_it still 'unprocessed'). The backend talks to Gemini directly (NFR-3); this
 * loop only paces the calls to respect the free tier's per-minute quota and never runs two
 * classify calls at once.
 *
 * Two distinct failure kinds:
 * - One-off (unparseable answer, a single network blip): leave that lead 'unprocessed', keep going.
 * - Quota exhaustion (HTTP 429 / RESOURCE_EXHAUSTED, seen twice in a row): stop the whole run
 *   immediately — the rest are left 'unprocessed' rather than burning 13-15s each on a call
 *   that's guaranteed to fail right now. Safe to re-run later (LeadsService.classify is
 *   idempotent), so nothing is lost by stopping early.
 */
export async function classifyLeads(
  targets: ClassifyTarget[],
  onProgress: (progress: ClassifyProgress) => void,
): Promise<void> {
  let unprocessed = 0;
  let consecutiveQuotaHits = 0;

  for (let i = 0; i < targets.length; i++) {
    let quotaExhausted = false;
    try {
      const result = await classifyLead(targets[i].id);
      quotaExhausted = result.quotaExhausted;
      if (result.outcome === 'unprocessed') unprocessed++;
    } catch {
      // Network-level failure, not a confirmed quota signal — treat as one-off.
      unprocessed++;
    }

    consecutiveQuotaHits = quotaExhausted ? consecutiveQuotaHits + 1 : 0;

    if (consecutiveQuotaHits >= CONSECUTIVE_QUOTA_HITS_TO_STOP) {
      const untried = targets.length - (i + 1);
      onProgress({ current: i + 1, total: targets.length, unprocessed: unprocessed + untried, stoppedEarly: true });
      return;
    }

    onProgress({ current: i + 1, total: targets.length, unprocessed, stoppedEarly: false });

    if (i < targets.length - 1) {
      await sleep(MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
    }
  }
}
