import type { LeadSaveResult } from './api';
import {
  IndeedBackgroundListTab,
  runIndeedAutoPagination,
  type IndeedAutoPaginationProgress,
  type IndeedAutoPaginationResult,
} from './indeed-pagination';
import type { IndeedRegion } from './indeed-regions';

// Multi-region Indeed run (02.10): whichever Indeed domain the manager starts from, the same
// search is walked on every selected region automatically, one after another — no further action
// from her. Each region goes through the exact same runIndeedAutoPagination as a single-domain
// run (date-range "Date posted" narrowing, next-link pagination, end-of-results detection,
// totalJobCount check), just in that region's own time zone and sharing ONE background window.

// Cooldown between regions — longer than the per-page delay since every region is a fresh search
// burst on a different Indeed domain. Untested guess; lowered 02.10 from 1-3 min, which read as a
// hang in the first live run (no visible countdown back then).
export const INDEED_REGION_PAUSE_MIN_MS = 45_000;
export const INDEED_REGION_PAUSE_MAX_MS = 90_000;

// Only the search query carries over from the manager's tab. Location is always the region's own
// remote location (remote-only hiring, 02.10 decision); every other param is either per-view state
// (vjk, start), locale-specific filter tokens (sc) that don't mean the same thing on another
// domain, or set by the run itself (sort, fromage).
export function buildIndeedRegionSearchUrl(sourceTabUrl: string, region: IndeedRegion): string {
  const source = new URL(sourceTabUrl);
  const url = new URL(`https://${region.host}/jobs`);
  url.searchParams.set('q', source.searchParams.get('q') ?? '');
  url.searchParams.set('l', region.remoteLocation);
  url.searchParams.set('sort', 'date');
  return url.toString();
}

// A finished region as shown in the run status ("Done: Canada (7 new), …").
export interface IndeedRegionDoneStatus {
  label: string;
  saved: number;
  // Set when the region ended on anything other than reaching the last results page.
  problem?: string;
}

export interface IndeedMultiRegionProgress {
  regionIndex: number; // 1-based
  regionCount: number;
  region: IndeedRegion;
  done: IndeedRegionDoneStatus[];
  queued: IndeedRegion[];
  phase: 'scanning' | 'batch_pause' | 'region_pause';
  // Current region's own pagination progress (null during the between-regions pause).
  pagination: IndeedAutoPaginationProgress | null;
  // During 'region_pause': when the pause ends (epoch ms) and which region comes next — the panel
  // shows a countdown so the wait isn't mistaken for a hang.
  pauseUntil?: number;
  nextRegion?: IndeedRegion;
}

export interface IndeedRegionRunResult {
  region: IndeedRegion;
  searchUrl: string;
  result: IndeedAutoPaginationResult;
}

export type IndeedMultiRegionStopReason = 'completed' | 'window_closed' | 'auth_error';

export interface IndeedMultiRegionResult {
  regions: IndeedRegionRunResult[];
  // Regions never started because the whole run stopped early.
  skippedRegions: IndeedRegion[];
  savedLeads: LeadSaveResult[];
  stopReason: IndeedMultiRegionStopReason;
}

/**
 * Walks `regions` in order. A region-level stop (sign-in wall, circuit breaker, max pages) only
 * ends THAT region — the run moves on to the next one. Only two things end the whole run: the
 * background window being closed (the manager's explicit interrupt) and a backend auth error
 * (nothing further could be saved anyway).
 */
const REGION_PROBLEM_LABELS: Partial<Record<IndeedAutoPaginationResult['stopReason'], string>> = {
  indeed_signin_required: 'sign-in required',
  circuit_breaker: 'bot check / errors',
  max_pages: 'page cap',
  window_closed: 'interrupted',
  auth_error: 'session expired',
};

export function formatIndeedRegionDone(d: IndeedRegionDoneStatus): string {
  return `${d.label} (${d.saved} new${d.problem ? `, ${d.problem}` : ''})`;
}

// One-line status for the background window's overlay — same three parts as the side panel.
function overlayStatus(current: IndeedRegion | null, done: IndeedRegionDoneStatus[], queued: IndeedRegion[]): string {
  const parts: string[] = [];
  if (current) parts.push(`Parsing: ${current.label}`);
  if (done.length) parts.push(`Done: ${done.map(formatIndeedRegionDone).join(', ')}`);
  if (queued.length) parts.push(`Queued: ${queued.map((r) => r.label).join(', ')}`);
  return parts.join(' · ');
}

export async function runIndeedMultiRegion(
  sourceTabUrl: string,
  regions: IndeedRegion[],
  range: { start: string; end: string },
  onProgress: (progress: IndeedMultiRegionProgress) => void,
): Promise<IndeedMultiRegionResult> {
  const tab = new IndeedBackgroundListTab();
  const results: IndeedRegionRunResult[] = [];
  const savedLeads: LeadSaveResult[] = [];
  let stopReason: IndeedMultiRegionStopReason = 'completed';
  const done: IndeedRegionDoneStatus[] = [];

  try {
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      const searchUrl = buildIndeedRegionSearchUrl(sourceTabUrl, region);
      const queued = regions.slice(i + 1);
      const emit = (
        phase: IndeedMultiRegionProgress['phase'],
        pagination: IndeedAutoPaginationProgress | null,
        pause?: { pauseUntil: number; nextRegion: IndeedRegion },
      ) => onProgress({ regionIndex: i + 1, regionCount: regions.length, region, done: [...done], queued, phase, pagination, ...pause });

      console.log(`[Indeed multi-region] ${i + 1}/${regions.length} ${region.label} — ${searchUrl}`);
      const status = overlayStatus(region, done, queued);
      tab.setProgress(status);
      emit('scanning', null);

      const result = await runIndeedAutoPagination(
        searchUrl,
        range,
        (p) => emit(p.phase === 'batch_pause' ? 'batch_pause' : 'scanning', p),
        { timeZone: region.timeZone, tab, logLabel: region.label, overlayPrefix: `${status} · ` },
      );
      results.push({ region, searchUrl, result });
      savedLeads.push(...result.savedLeads);
      done.push({ label: region.label, saved: result.postingsSaved, problem: REGION_PROBLEM_LABELS[result.stopReason] });

      if (result.stopReason === 'window_closed') {
        stopReason = 'window_closed';
        break;
      }
      if (result.stopReason === 'auth_error') {
        stopReason = 'auth_error';
        break;
      }

      if (i < regions.length - 1) {
        const pauseMs = INDEED_REGION_PAUSE_MIN_MS + Math.random() * (INDEED_REGION_PAUSE_MAX_MS - INDEED_REGION_PAUSE_MIN_MS);
        const nextRegion = regions[i + 1];
        tab.setProgress(
          `Waiting ~${Math.round(pauseMs / 1000)}s before ${nextRegion.label} (anti-bot cooldown) · ${overlayStatus(null, done, queued)}`,
        );
        await tab.refreshOverlay();
        emit('region_pause', null, { pauseUntil: Date.now() + pauseMs, nextRegion });
        if (await tab.pacedDelay(pauseMs, pauseMs)) {
          stopReason = 'window_closed';
          break;
        }
      }
    }
  } finally {
    await tab.close();
  }

  const startedIds = new Set(results.map((r) => r.region.id));
  return {
    regions: results,
    skippedRegions: regions.filter((r) => !startedIds.has(r.id)),
    savedLeads,
    stopReason,
  };
}
