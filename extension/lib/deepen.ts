import { deepenLead } from './api';
import type { DeepenedFields, DeepeningStrategy, DeepeningTarget } from './deepening-strategy';
import { parseTechjobsDetail } from './parsers/techjobs';

const MIN_DELAY_MS = 1500;
const MAX_DELAY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DeepenTarget {
  id: string;
  source_url: string;
}

export interface DeepenProgress {
  current: number;
  total: number;
  // 24.09 follow-up: running count of successful deepens so far this run — added so a caller
  // can build a persistent completion summary ("N of M succeeded") the same way
  // WellfoundDeepenProgress already carries `succeeded`, without needing its own separate
  // tally. Purely additive to this interface; existing consumers that only read
  // current/total (multipage.ts) are unaffected.
  succeeded: number;
}

export interface DeepenResult {
  processed: number;
  succeeded: number;
}

// CLAUDE.md scope D (Wellfound): the DeepeningStrategy this whole module always used, now
// named and exposed so the core (App.tsx) can pick a different one (TabDeepening, for
// sources a plain fetch can't reach) without needing to know how either works.
export class FetchDeepening implements DeepeningStrategy {
  async deepenOne(target: DeepeningTarget): Promise<DeepenedFields | null> {
    const res = await fetch(target.source_url);
    if (!res.ok) return null;
    const html = await res.text();
    return parseTechjobsDetail(html);
  }
}

/**
 * CLAUDE.md scope B ("auto by all", human pace): sequentially fetches each NEW lead's detail
 * page and applies what it finds. Runs in the side panel (not the background service worker)
 * so the delay-based loop can't be cut short by MV3 service-worker suspension — it simply
 * stops if the panel is closed, which is an acceptable trade-off for this MVP.
 * A failure on one lead (network, parse, save) is swallowed so the run keeps going (NFR-12/13:
 * no crash, no silent total failure — surfaced via onProgress instead).
 *
 * 24.09 follow-up: now returns a DeepenResult (processed/succeeded counts) instead of void, and
 * onProgress's payload carries a running `succeeded` tally — purely additive surfacing of an
 * outcome this function already computed internally (whether `detail` came back truthy) and
 * previously discarded. No change to the loop's own behavior: same targets, same pacing, same
 * per-lead try/catch, same fetch/parse/save sequence.
 */
export async function deepenLeads(
  targets: DeepenTarget[],
  onProgress: (progress: DeepenProgress) => void,
): Promise<DeepenResult> {
  const strategy = new FetchDeepening();
  let succeeded = 0;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    try {
      const detail = await strategy.deepenOne(target);
      if (detail) {
        await deepenLead(target.id, {
          description: detail.description,
          company: detail.company,
          company_website: detail.company_website,
          ...(detail.published_at ? { published_at: detail.published_at } : {}),
        });
        succeeded++;
      }
    } catch {
      // Swallow: one bad detail page must not abort the rest of the run.
    }

    onProgress({ current: i + 1, total: targets.length, succeeded });

    if (i < targets.length - 1) {
      await sleep(MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
    }
  }

  return { processed: targets.length, succeeded };
}
