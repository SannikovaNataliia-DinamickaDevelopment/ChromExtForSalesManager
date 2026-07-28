import { deepenLead } from './api';
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
}

/**
 * CLAUDE.md scope B ("auto by all", human pace): sequentially fetches each NEW lead's detail
 * page and applies what it finds. Runs in the side panel (not the background service worker)
 * so the delay-based loop can't be cut short by MV3 service-worker suspension — it simply
 * stops if the panel is closed, which is an acceptable trade-off for this MVP.
 * A failure on one lead (network, parse, save) is swallowed so the run keeps going (NFR-12/13:
 * no crash, no silent total failure — surfaced via onProgress instead).
 */
export async function deepenLeads(
  targets: DeepenTarget[],
  onProgress: (progress: DeepenProgress) => void,
): Promise<void> {
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    try {
      const res = await fetch(target.source_url);
      if (res.ok) {
        const html = await res.text();
        const detail = parseTechjobsDetail(html);
        if (detail) {
          await deepenLead(target.id, {
            description: detail.description,
            company: detail.company,
            company_website: detail.company_website,
            ...(detail.published_at ? { published_at: detail.published_at } : {}),
          });
        }
      }
    } catch {
      // Swallow: one bad detail page must not abort the rest of the run.
    }

    onProgress({ current: i + 1, total: targets.length });

    if (i < targets.length - 1) {
      await sleep(MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
    }
  }
}
