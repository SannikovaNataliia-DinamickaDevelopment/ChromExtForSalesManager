import { useEffect, useRef, useState } from 'react';
import { AuthError, fetchLeads, type LeadSaveResult } from '../../lib/api';
import { fetchMe, login, logout, type CurrentUser } from '../../lib/auth';
import { classifyLeads, type ClassifyProgress } from '../../lib/classify';
import { deepenLeads, type DeepenProgress } from '../../lib/deepen';
import { MAX_PAGES, runMultiPageParse, type MultiPageProgress } from '../../lib/multipage';
import { getStoredTheme, setStoredTheme, type Theme } from '../../lib/theme';
import {
  deepenWellfoundLeads,
  runWellfoundAutoDeepenWaves,
  WELLFOUND_AUTO_BATCH_PAUSE_MAX_MS,
  WELLFOUND_AUTO_BATCH_PAUSE_MIN_MS,
  WELLFOUND_AUTO_BATCH_POSTINGS,
  WELLFOUND_CIRCUIT_BREAKER_THRESHOLD,
  WELLFOUND_RUN_CAP,
  type WellfoundAutoDeepenWaveProgress,
  type WellfoundDeepenProgress,
} from '../../lib/wellfound-deepen';
import {
  getBookmark,
  isBookmarkFresh,
  setBookmark,
  stripPageParam,
  type WellfoundPaginationBookmark,
} from '../../lib/wellfound-pagination-bookmark';
import {
  runWellfoundAutoPagination,
  runWellfoundPagination,
  WELLFOUND_AUTO_PAGINATION_MAX_PAGES,
  WELLFOUND_PAGINATION_BATCH_SIZE,
  type WellfoundAutoPaginationProgress,
  type WellfoundPaginationProgress,
  type WellfoundPaginationResult,
} from '../../lib/wellfound-pagination';
import {
  INDEED_AUTO_BATCH_PAUSE_MAX_MS,
  INDEED_AUTO_BATCH_PAUSE_MIN_MS,
  INDEED_AUTO_BATCH_PAGES,
  INDEED_CIRCUIT_BREAKER_THRESHOLD,
  INDEED_AUTO_PAGINATION_MAX_PAGES,
  formatIndeedPageLogEntry,
  type IndeedAutoPaginationResult,
} from '../../lib/indeed-pagination';
import {
  INDEED_REGION_PAUSE_MAX_MS,
  INDEED_REGION_PAUSE_MIN_MS,
  formatIndeedRegionDone,
  runIndeedMultiRegion,
  type IndeedMultiRegionProgress,
} from '../../lib/indeed-multi-region';
import { DEFAULT_INDEED_REGION_IDS, findIndeedRegionByHost, INDEED_REGIONS, isIndeedHost } from '../../lib/indeed-regions';
import { RegionDropdown } from './RegionDropdown';

const INDEED_REGIONS_STORAGE_KEY = 'indeedSelectedRegionIds';
import { INDEED_HUMAN_CHECK_WAIT_MS, subscribeIndeedHumanCheck } from '../../lib/indeed-background-window';
import {
  deepenIndeedLeads,
  runIndeedAutoDeepenWaves,
  INDEED_DEEPEN_RUN_CAP,
  type IndeedAutoDeepenWaveProgress,
  type IndeedDeepenProgress,
} from '../../lib/indeed-deepen';
import DateRangePicker, { type DateRange } from './DateRangePicker';
import type { JobLeadRecord } from '../../lib/types';

// Multi-page (scope D) only works on sites built on this template — confirmed identical
// pagination/card structure for both (CLAUDE.md "Parser spec"). DevITjobs stays out (paused).
const MULTIPAGE_HOSTNAMES = ['www.techjobs.ca', 'www.itjobs.ca'];

// Separate, dedicated Wellfound-only list-pagination flow (see wellfound-pagination.ts) — not
// the MULTIPAGE_HOSTNAMES block above, which stays Techjobs/ITjobs-only.
const WELLFOUND_HOSTNAME = 'wellfound.com';


// 19.08 call: the fixed-5-page-batch "Parse from here"/"Continue" flow below is replaced for
// normal use by the automated all-pages flow (handleWellfoundAutoParse) — a significant enough
// behavior change that the old UI stays in the code as a fallback rather than being deleted.
// Flip this back to true (and nothing else) to restore it if the automated flow needs to be
// rolled back.
const SHOW_LEGACY_WELLFOUND_PAGINATION = false;

// Side panel liveness port (background.ts's dashboard-triggered Wellfound enrichment guard):
// connecting here just tells background.ts "the side panel is currently open" for as long as
// this port stays connected — background.ts tracks the connection, this side never reads or
// sends anything over it. Kept as a literal, not a shared import — see background.ts's own
// SIDEPANEL_PORT_NAME comment for why. Must match that copy exactly.
const SIDEPANEL_PORT_NAME = 'sidepanel-alive';

// Quick-launch row (right under the heading) — lets the manager jump straight to a supported
// site without already having the right page open. Three of the four go to a specific search
// rather than a bare homepage (more useful as a one-click starting point); DevITjobs stays the
// generic homepage since it has no equivalent dedicated search/pagination flow to mirror.
const QUICK_LAUNCH_SITES = [
  // Same path the parser's own baseUrl resolves to for real list cards — confirmed against
  // spikes/techjobs_list.html's canonical URL (https://www.techjobs.ca/jobs/browse), not
  // guessed. TechjobsListParser (parsers/techjobs.ts) and the back-to-date pagination
  // (multipage.ts) both just append to whatever URL is already open rather than hardcoding
  // this path themselves, so this is the one place in the codebase that spells it out.
  { label: 'Techjobs.ca', url: 'https://www.techjobs.ca/jobs/browse' },
  { label: 'ITjobs.ca', url: 'https://www.itjobs.ca/jobs?workplace=REMOTE&q=Software+engineer' },
  { label: 'DevITjobs', url: 'https://devitjobs.nl' },
  { label: 'Wellfound', url: 'https://wellfound.com/role/r/software-engineer?page=1' },
  { label: 'Indeed', url: 'https://www.indeed.com/jobs?q=software+engineer' },
];

// Indeed deepen targets: leads still missing a description, ONE entry per lead id. 25.09 fix:
// runIndeedAutoPagination's savedLeads carries one save result per save call, so a lead saved on
// several pages showed up once per save — a 21-unique-lead run queued 805 deepen visits. Every
// entry for a repeated lead also carries the pre-deepen snapshot (no description yet), so the
// description filter alone never catches the repeats.
function uniqueIndeedDeepenTargets(results: unknown): { id: string; source_url: string }[] {
  const items = Array.isArray(results) ? (results as LeadSaveResult[]) : [];
  const byId = new Map<string, { id: string; source_url: string }>();
  for (const r of items) {
    if (!r?.lead || r.lead.description || r.lead.enrichment_error) continue;
    byId.set(r.lead.id, { id: r.lead.id, source_url: r.lead.source_url });
  }
  return [...byId.values()];
}

// One-line outcome of a single region's pagination run (multi-region summary).
function summarizeIndeedRegion(result: IndeedAutoPaginationResult): string {
  // Shown side by side, not as "X of N": a page's model can include extra postings beyond the
  // search results, so scanned may legitimately exceed Indeed's own count.
  const reported = result.indeedTotalJobCount !== null ? ` (Indeed reports ${result.indeedTotalJobCount} results)` : '';
  const counts =
    `${result.postingsScanned} scanned${reported} — ${result.postingsSaved} new, ` +
    `${result.postingsAlreadyKnown} already in DB, ${result.postingsSkippedOutOfRange} out of range`;
  switch (result.stopReason) {
    case 'indeed_signin_required':
      return `${counts}. STOPPED: Indeed asked to sign in — sign into this Indeed domain in this Chrome profile and re-run.`;
    case 'circuit_breaker':
      return `${counts}. STOPPED after ${INDEED_CIRCUIT_BREAKER_THRESHOLD} consecutive page failures (possible bot check)${result.errorMessage ? `: ${result.errorMessage}` : ''}.`;
    case 'window_closed':
      return `${counts}. Interrupted (window closed).`;
    case 'auth_error':
      return `${counts}. Stopped: backend session expired.`;
    case 'max_pages':
      return `${counts}. Hit the ${INDEED_AUTO_PAGINATION_MAX_PAGES}-page safety cap.`;
    default:
      return `${counts}. Done (${result.pagesProcessed} page(s)).`;
  }
}

function currentPageFromTabUrl(url: string): number {
  try {
    const raw = new URL(url).searchParams.get('page');
    const n = raw ? parseInt(raw, 10) : 1;
    return Number.isFinite(n) && n >= 1 ? n : 1;
  } catch {
    return 1;
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function SunIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z" />
    </svg>
  );
}

// Visual-only preference toggle, not part of the extension's business logic — see
// lib/theme.ts for the chrome.storage.local persistence it's wired to in App().
function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const isLight = theme === 'light';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
      title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
    >
      <span className={`theme-toggle-track ${theme}`}>
        <span className="theme-toggle-thumb">{isLight ? <SunIcon /> : <MoonIcon />}</span>
      </span>
    </button>
  );
}

export default function App() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [tabSupported, setTabSupported] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deepening, setDeepening] = useState<DeepenProgress | null>(null);
  // 24.09 follow-up: persistent completion message for the generic runDeepen path (shared by
  // Techjobs/ITjobs/Indeed), mirroring wellfoundDeepenSummary's pattern below — the `deepening`
  // hint above is transient (cleared the instant the run ends via runDeepen's own
  // .finally(() => setDeepening(null))), so without this there was no way to tell after the fact
  // whether a deepen run happened, succeeded, or had nothing to do. Set once at the end of
  // runDeepen (never mid-run — deepening's own live count covers that), cleared at the start of
  // the next run, same lifecycle as wellfoundDeepenSummary.
  const [deepenSummary, setDeepenSummary] = useState<string | null>(null);
  const [classifying, setClassifying] = useState<ClassifyProgress | null>(null);
  const [classifySummary, setClassifySummary] = useState<string | null>(null);
  const [targetDate, setTargetDate] = useState('');
  const [multiPageRunning, setMultiPageRunning] = useState(false);
  const [multiPageProgress, setMultiPageProgress] = useState<MultiPageProgress | null>(null);
  const [multiPageSummary, setMultiPageSummary] = useState<string | null>(null);
  const [wellfoundDeepening, setWellfoundDeepening] = useState<WellfoundDeepenProgress | null>(null);
  const [wellfoundDeepenSummary, setWellfoundDeepenSummary] = useState<string | null>(null);
  const [wellfoundListTabUrl, setWellfoundListTabUrl] = useState<string | null>(null);
  const [wellfoundBookmark, setWellfoundBookmark] = useState<WellfoundPaginationBookmark | null>(null);
  // Active tab's hostname, kept in sync alongside wellfoundListTabUrl below (same refresh
  // function/trigger points) — drives which site-specific control set renders (Techjobs'
  // back-to-date block, Wellfound's pagination block, or neither), independent of tabSupported
  // (which only says "is parsing possible here", not "which site").
  const [activeHostname, setActiveHostname] = useState<string | null>(null);
  // Which button triggered the in-flight batch, if any — drives both buttons' disabled state
  // (non-null means "a batch is running", regardless of which button started it) and which one
  // shows the "Parsing pages…" label (only the button that was actually clicked).
  const [wellfoundPageRunningSource, setWellfoundPageRunningSource] = useState<'parse_from_here' | 'continue' | null>(null);
  // Synchronous, render-independent guard against a double-trigger: a fast double-click (or
  // clicking the other button) in the brief window before setWellfoundPageRunningSource's
  // update actually re-renders and disables the DOM buttons. Checked-and-set as the very first,
  // non-awaited statement in runWellfoundPageBatch, so a second invocation is rejected
  // synchronously before it does anything — see that function for why the state above alone
  // isn't enough.
  const wellfoundPageRunningRef = useRef(false);
  const [wellfoundPageProgress, setWellfoundPageProgress] = useState<WellfoundPaginationProgress | null>(null);
  const [wellfoundPageSummary, setWellfoundPageSummary] = useState<string | null>(null);
  // 19.08 call: automated all-pages Wellfound flow, replacing the block above for normal use
  // (see SHOW_LEGACY_WELLFOUND_PAGINATION). Same synchronous-ref double-click guard as
  // wellfoundPageRunningRef above — only one button here, but the guard is still needed against
  // a fast double-click before React re-renders and disables it.
  const [wellfoundAutoRange, setWellfoundAutoRange] = useState<DateRange | null>(null);
  const wellfoundAutoRunningRef = useRef(false);
  const [wellfoundAutoRunning, setWellfoundAutoRunning] = useState(false);
  const [wellfoundAutoProgress, setWellfoundAutoProgress] = useState<WellfoundAutoPaginationProgress | null>(null);
  const [wellfoundAutoSummary, setWellfoundAutoSummary] = useState<string | null>(null);
  // Distinct from wellfoundDeepening/wellfoundDeepenSummary (shared by handleParse and the
  // legacy pagination flow) — this automated flow can surface far more leads in one run, so its
  // deepening runs in waves (runWellfoundAutoDeepenWaves) with its own progress shape; keeping
  // it in separate state avoids one flow's summary overwriting the other's mid-run.
  const [wellfoundAutoDeepenProgress, setWellfoundAutoDeepenProgress] = useState<WellfoundAutoDeepenWaveProgress | null>(null);
  const [wellfoundAutoDeepenSummary, setWellfoundAutoDeepenSummary] = useState<string | null>(null);
  // DI-2966: Indeed's own auto-pagination state, parallel to the Wellfound block above.
  // 24.09 follow-up: now has a date range too (indeedAutoRange), same picked-range-before-saving
  // filter as Wellfound's wellfoundAutoRange — see runIndeedAutoPagination's doc comment for why
  // it's a simpler single direct comparison rather than Wellfound's precise-or-approximate
  // fallback chain.
  const [indeedListTabUrl, setIndeedListTabUrl] = useState<string | null>(null);
  const [indeedAutoRange, setIndeedAutoRange] = useState<DateRange | null>(null);
  const indeedAutoRunningRef = useRef(false);
  const [indeedAutoRunning, setIndeedAutoRunning] = useState(false);
  const [indeedAutoProgress, setIndeedAutoProgress] = useState<IndeedMultiRegionProgress | null>(null);
  // Regions the multi-region run walks (RegionDropdown). Remembered in this browser between
  // sessions — a per-viewer convenience, so localStorage (guarded: it can throw or be empty);
  // ids no longer in INDEED_REGIONS are dropped on load.
  const [indeedSelectedRegionIds, setIndeedSelectedRegionIds] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(INDEED_REGIONS_STORAGE_KEY) ?? 'null');
      if (Array.isArray(saved)) return saved.filter((id) => INDEED_REGIONS.some((r) => r.id === id));
    } catch {
      // fall through to the defaults
    }
    return DEFAULT_INDEED_REGION_IDS;
  });
  useEffect(() => {
    try {
      localStorage.setItem(INDEED_REGIONS_STORAGE_KEY, JSON.stringify(indeedSelectedRegionIds));
    } catch {
      // not persisted this time — selection still works for this session
    }
  }, [indeedSelectedRegionIds]);
  // One line per region from the last multi-region run.
  const [indeedRegionSummaries, setIndeedRegionSummaries] = useState<string[] | null>(null);
  const [indeedAutoSummary, setIndeedAutoSummary] = useState<string | null>(null);
  // Diagnostic per-page log of the last Indeed auto-pagination run (formatIndeedPageLogEntry
  // lines) — kept until the next run starts, same lifecycle as indeedAutoSummary.
  const [indeedPageLog, setIndeedPageLog] = useState<string[] | null>(null);
  // 24.09 follow-up (deepening architecture fix): Indeed's own dedicated deepening state, same
  // shape/reasoning as wellfoundDeepening/wellfoundDeepenSummary above — no longer shares the
  // generic `deepening`/`deepenSummary` state with Techjobs/ITjobs (see runIndeedDeepen's own
  // comment for why: the plain FetchDeepening it used to share was confirmed 403'd by Indeed's
  // anti-bot for every request, so Indeed now needs the same real-background-tab architecture as
  // Wellfound, which has its own circuit-breaker/window-closed states the simpler generic
  // runDeepen/deepenLeads shape has no room for).
  const [indeedDeepening, setIndeedDeepening] = useState<IndeedDeepenProgress | null>(null);
  // True while an Indeed run is paused on a Cloudflare check the manager has to tick herself
  // (indeed-background-window.ts's waitForHumanCheck).
  const [indeedHumanCheck, setIndeedHumanCheck] = useState(false);
  // 1s clock, only while an Indeed between-regions pause is running — drives its countdown.
  const [nowTick, setNowTick] = useState(() => Date.now());
  const indeedRegionPausing = indeedAutoProgress?.phase === 'region_pause';
  useEffect(() => {
    if (!indeedRegionPausing) return;
    setNowTick(Date.now());
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [indeedRegionPausing]);
  useEffect(() => subscribeIndeedHumanCheck(setIndeedHumanCheck), []);
  const [indeedDeepenSummary, setIndeedDeepenSummary] = useState<string | null>(null);
  // Wave-based counterpart, parallel to wellfoundAutoDeepenProgress/wellfoundAutoDeepenSummary —
  // handleIndeedAutoParse's auto-pagination can surface far more leads in one run than
  // INDEED_DEEPEN_RUN_CAP handles alone, so its deepening runs in waves
  // (runIndeedAutoDeepenWaves) with its own progress shape; kept separate so it can't overwrite
  // the single-lead-batch summary above mid-run.
  const [indeedAutoDeepenProgress, setIndeedAutoDeepenProgress] = useState<IndeedAutoDeepenWaveProgress | null>(null);
  const [indeedAutoDeepenSummary, setIndeedAutoDeepenSummary] = useState<string | null>(null);
  // Default is dark, matching the dashboard's current (only) look, until/unless the user's
  // stored choice loads from chrome.storage.local (see lib/theme.ts).
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    getStoredTheme().then((stored) => {
      if (stored) setTheme(stored);
    });
  }, []);

  // See SIDEPANEL_PORT_NAME's comment above — this connection's only purpose is its own
  // lifetime: background.ts tracks connect/disconnect to know whether the side panel is open,
  // for the dashboard-triggered Wellfound enrichment guard. Reconnects on every mount
  // (opening the panel); the explicit disconnect on unmount isn't strictly required (Chrome
  // fires the background side's onDisconnect on its own once the panel's document is gone
  // either way) but makes the "closed" transition immediate rather than waiting on Chrome's
  // own teardown timing.
  //
  // Self-healing (bug fix): the background service worker can die and restart independently of
  // this panel — an MV3 idle-timeout, a crash, a browser update — without this panel's own
  // React tree ever unmounting. The old service-worker instance's copy of this port dies with
  // it, but a plain one-shot connect() here would never notice: background.ts's
  // openSidePanelCount would silently reset to 0 in the fresh worker instance while the panel
  // stays visibly open, producing a false "open the side panel first" error on the next
  // dashboard-triggered Wellfound action even though it never actually closed. Reconnecting on
  // every onDisconnect (not just once on mount) keeps that bookkeeping accurate regardless of
  // why the previous connection died.
  useEffect(() => {
    let disposed = false;
    let port: chrome.runtime.Port | null = null;

    const connect = () => {
      if (disposed) return;
      try {
        port = chrome.runtime.connect({ name: SIDEPANEL_PORT_NAME });
      } catch {
        // Extension context invalidated (e.g. the extension itself was just reloaded) — Chrome
        // tears down this whole document in that case anyway, nothing further to do here.
        return;
      }
      port.onDisconnect.addListener(() => {
        if (!disposed) connect();
      });
    };
    connect();

    return () => {
      disposed = true;
      port?.disconnect();
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setStoredTheme(next);
  };

  // Any backend call can 401 out from under a signed-in session (expiry, logout
  // elsewhere, backend restart clearing the in-memory revocation list) — funnel
  // every failure through here so the UI drops back to "Sign in" consistently.
  const handleAuthAware = (err: unknown) => {
    if (err instanceof AuthError) {
      setUser(null);
      setError('Please sign in again.');
    } else {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const refreshTabStatus = () => {
    chrome.runtime.sendMessage({ type: 'GET_TAB_STATUS' }).then((res) => {
      setTabSupported(!!res?.supported);
    });
  };

  // Keeps activeHostname (which site-specific control block renders) and, for Wellfound
  // specifically, the "Continue" button's enabled/shown state + target page label in sync with
  // whichever context is currently open in the active tab — same trigger points (tab
  // activated/updated) as refreshTabStatus above.
  const refreshActiveTabContext = () => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      let hostname = '';
      try {
        hostname = tab?.url ? new URL(tab.url).hostname : '';
      } catch {
        // leave hostname empty; falls through to the "not a Wellfound tab" branch below
      }
      setActiveHostname(hostname || null);

      if (!tab?.url || hostname !== WELLFOUND_HOSTNAME) {
        setWellfoundListTabUrl(null);
        setWellfoundBookmark(null);
      } else {
        setWellfoundListTabUrl(tab.url);
        getBookmark(stripPageParam(tab.url)).then(setWellfoundBookmark);
      }

      // DI-2966: no bookmark concept for Indeed (runIndeedAutoPagination always walks from
      // page 1 — see that function's doc comment), so this just tracks whether the block
      // should render at all, same as wellfoundListTabUrl's role above.
      setIndeedListTabUrl(tab?.url && isIndeedHost(hostname) ? tab.url : null);
    });
  };

  useEffect(() => {
    fetchMe()
      .then((me) => {
        setUser(me);
      })
      .catch(handleAuthAware)
      .finally(() => setAuthChecked(true));

    refreshTabStatus();
    refreshActiveTabContext();
    chrome.tabs.onActivated.addListener(refreshTabStatus);
    chrome.tabs.onUpdated.addListener(refreshTabStatus);
    chrome.tabs.onActivated.addListener(refreshActiveTabContext);
    chrome.tabs.onUpdated.addListener(refreshActiveTabContext);
    return () => {
      chrome.tabs.onActivated.removeListener(refreshTabStatus);
      chrome.tabs.onUpdated.removeListener(refreshTabStatus);
      chrome.tabs.onActivated.removeListener(refreshActiveTabContext);
      chrome.tabs.onUpdated.removeListener(refreshActiveTabContext);
    };
  }, []);

  const handleLogin = async () => {
    setSigningIn(true);
    setError(null);
    try {
      const res = await login();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const me = await fetchMe();
      setUser(me);
    } finally {
      setSigningIn(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  // CLAUDE.md scope C: runs after deepening, human-paced (Gemini free-tier quota, not anti-ban).
  // Targets ALL currently-loaded leads that are ready and still unprocessed — not just this
  // batch — so a re-parse also retries anything a previous run's quota errors left behind.
  const runClassify = async () => {
    let fresh: JobLeadRecord[];
    try {
      fresh = await fetchLeads();
    } catch (err) {
      handleAuthAware(err);
      return;
    }
    // CLAUDE.md scope D (Wellfound): Gemini stays OFF for Wellfound leads — permanently
    // excluded here, not just for this run, so they never get swept in by a later re-parse.
    const targets = fresh
      .filter((l) => l.description && l.is_it === 'unprocessed' && l.source_site !== 'wellfound')
      .map((l) => ({ id: l.id }));
    if (targets.length === 0) return;

    setClassifySummary(null);
    setClassifying({ current: 0, total: targets.length, unprocessed: 0, stoppedEarly: false });
    let finalUnprocessed = 0;
    let finalStoppedEarly = false;
    await classifyLeads(targets, (progress) => {
      finalUnprocessed = progress.unprocessed;
      finalStoppedEarly = progress.stoppedEarly;
      setClassifying(progress);
    });
    setClassifying(null);
    if (finalStoppedEarly) {
      setClassifySummary(`Gemini quota reached — stopped early, ${finalUnprocessed} lead(s) left unprocessed. Re-parse later to continue.`);
    } else if (finalUnprocessed > 0) {
      setClassifySummary(
        `${finalUnprocessed} lead(s) left unprocessed (rate limit or unclear answer) — re-parse later to retry.`,
      );
    }
  };

  // CLAUDE.md scope B ("Auto by all"): runs unattended after a list parse, human-paced,
  // deepening only leads with no description yet (skips already-deepened/pre-existing ones).
  // Also skips any lead already carrying enrichment_error — an automatic queue never retries a
  // flagged lead on its own; only an explicit manual retry (dashboard's Enrich button) does.
  //
  // Shared by Techjobs/ITjobs (handleParse's generic branch) and Indeed (handleParse's isIndeed
  // branch) — both parse-then-deepen through this exact same function, so the persistent
  // completion summary added below (24.09 follow-up, mirroring wellfoundDeepenSummary's
  // pattern) applies to all three alike. Purely additive: a confirmation message where there
  // was none before, not a behavior change to targets-filtering, pacing, or deepenLeads itself.
  const runDeepen = (results: unknown): Promise<void> => {
    const items = Array.isArray(results) ? (results as LeadSaveResult[]) : [];
    const targets = items
      .filter((r) => r?.lead && !r.lead.description && !r.lead.enrichment_error)
      .map((r) => ({ id: r.lead.id, source_url: r.lead.source_url }));
    setDeepenSummary(null);
    if (targets.length === 0) {
      // Distinguishable from "ran and succeeded" — e.g. every lead in this batch was already
      // deepened earlier (a previous parse, or the dashboard's manual Enrich button), so there
      // was genuinely nothing to do. Previously this case set no state at all, indistinguishable
      // from the run never having started.
      setDeepenSummary('Nothing to deepen — all leads already had descriptions.');
      return Promise.resolve();
    }

    setDeepening({ current: 0, total: targets.length, succeeded: 0 });
    return deepenLeads(targets, (progress) => {
      setDeepening(progress);
    })
      .then((result) => {
        setDeepenSummary(`Deepening done — ${result.succeeded} of ${result.processed} lead(s) succeeded.`);
      })
      .finally(() => setDeepening(null));
  };

  // CLAUDE.md scope D (Wellfound): TabDeepening instead of the plain-fetch strategy above —
  // Wellfound's DataDome bot-protection blocks a background fetch outright (confirmed via a
  // real curl: HTTP 403 challenge page). Deliberately does NOT chain into runClassify —
  // Gemini stays off for Wellfound leads. Also skips any lead already carrying
  // enrichment_error (e.g. a Wellfound posting that previously 404'd) — this automatic queue
  // never retries a flagged lead on its own; only an explicit manual retry does.
  const runWellfoundDeepen = (results: unknown): Promise<void> => {
    const items = Array.isArray(results) ? (results as LeadSaveResult[]) : [];
    const targets = items
      .filter((r) => r?.lead && !r.lead.description && !r.lead.enrichment_error)
      .map((r) => ({ id: r.lead.id, source_url: r.lead.source_url }));
    if (targets.length === 0) return Promise.resolve();

    setWellfoundDeepenSummary(null);
    setWellfoundDeepening({ current: 0, total: targets.length, succeeded: 0, stoppedEarly: false });
    return deepenWellfoundLeads(targets, (progress) => {
      setWellfoundDeepening(progress);
    })
      .then((result) => {
        if (result.interrupted) {
          setWellfoundDeepenSummary(
            `Wellfound deepening was interrupted — the background window was closed. ` +
              `${result.succeeded} of ${result.processed} attempted lead(s) completed before that; already-saved leads were kept. ` +
              'The rest are still missing a description — re-run "Parse current list page", or use the dashboard\'s Enrich button, to retry them.',
          );
        } else if (result.stoppedEarly) {
          setWellfoundDeepenSummary(
            `Wellfound deepening stopped after ${WELLFOUND_CIRCUIT_BREAKER_THRESHOLD} consecutive failures — ` +
              `possible bot-detection block. ${result.succeeded} of ${result.processed} attempted lead(s) succeeded.`,
          );
        } else {
          setWellfoundDeepenSummary(`Wellfound deepening done — ${result.succeeded} of ${result.processed} lead(s) succeeded.`);
        }
      })
      .finally(() => setWellfoundDeepening(null));
  };

  // 24.09 follow-up (deepening architecture fix): Indeed's equivalent of runWellfoundDeepen
  // above — uses deepenIndeedLeads (indeed-deepen.ts's real-background-tab strategy) instead of
  // the plain-fetch runDeepen/deepenLeads this used to call, now that FetchDeepening is confirmed
  // 403'd by Indeed's anti-bot for every request. Same targets-filtering as every other deepen
  // wrapper in this file; the only thing that changed is what actually fetches the description
  // underneath.
  const runIndeedDeepen = (results: unknown): Promise<void> => {
    const targets = uniqueIndeedDeepenTargets(results);
    if (targets.length === 0) return Promise.resolve();

    setIndeedDeepenSummary(null);
    setIndeedDeepening({ current: 0, total: targets.length, succeeded: 0, stoppedEarly: false });
    return deepenIndeedLeads(targets, (progress) => {
      setIndeedDeepening(progress);
    })
      .then((result) => {
        if (result.interrupted) {
          setIndeedDeepenSummary(
            `Indeed deepening was interrupted — the background window was closed. ` +
              `${result.succeeded} of ${result.processed} attempted lead(s) completed before that; already-saved leads were kept. ` +
              'The rest are still missing a description — re-run "Parse current list page", or use the dashboard\'s Enrich button, to retry them.',
          );
        } else if (result.stoppedEarly) {
          setIndeedDeepenSummary(
            `Indeed deepening stopped after ${INDEED_CIRCUIT_BREAKER_THRESHOLD} consecutive failures — ` +
              `possible bot-detection block. ${result.succeeded} of ${result.processed} attempted lead(s) succeeded.`,
          );
        } else {
          setIndeedDeepenSummary(`Indeed deepening done — ${result.succeeded} of ${result.processed} lead(s) succeeded.`);
        }
      })
      .finally(() => setIndeedDeepening(null));
  };

  const handleParse = async () => {
    setParsing(true);
    setError(null);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'PARSE_ACTIVE_TAB' });
      if (!res?.ok) {
        if (res?.authError) {
          setUser(null);
          setError('Please sign in again.');
        } else {
          setError(res?.error ?? 'Parsing failed.');
        }
      } else {
        const results = Array.isArray(res.results) ? (res.results as LeadSaveResult[]) : [];
        const isWellfound = results.some((r) => r?.lead?.source_site === 'wellfound');
        // 24.09 follow-up (deepening architecture fix): Indeed leads auto-deepen via
        // runIndeedDeepen — indeed-deepen.ts's real-background-tab strategy — NOT the generic
        // runDeepen/FetchDeepening below. Confirmed live that FetchDeepening was 403'd by
        // Indeed's anti-bot for every request; the earlier assumption that it "worked" (based on
        // the dashboard's manual Enrich button appearing to succeed) turned out to be unreliable/
        // coincidental. Kept as its own branch (not folded into the generic else below) since it
        // needs an entirely different underlying strategy, not just a different Gemini choice.
        const isIndeed = results.some((r) => r?.lead?.source_site === 'indeed');
        if (isWellfound) {
          runWellfoundDeepen(results);
        } else if (isIndeed) {
          // Not awaited (fire-and-forget, same as the other two branches) — but WITH a .catch,
          // same as before: a rejected promise here would otherwise vanish as an unhandled
          // rejection with zero UI feedback.
          runIndeedDeepen(results).catch((err) => setError(err instanceof Error ? err.message : String(err)));
        } else {
          runDeepen(res.results).then(runClassify);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  };

  // CLAUDE.md scope D (DEMO): a separate, manually-triggered action from "Parse current list
  // page" above — walks pages 1..N via the URL `page` param until `targetDate` is covered.
  // Deliberately does NOT run Gemini classification (scope C) here.
  const handleMultiPageParse = async () => {
    if (!targetDate) {
      setError('Pick a "parse back to" date first.');
      return;
    }

    setError(null);
    setMultiPageSummary(null);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let hostname = '';
    try {
      hostname = tab?.url ? new URL(tab.url).hostname : '';
    } catch {
      // leave hostname empty; falls through to the "not on techjobs.ca" error below
    }
    if (!tab?.id || !MULTIPAGE_HOSTNAMES.includes(hostname)) {
      setError('Open a Techjobs.ca or ITjobs.ca list page in this tab first (DevITjobs is not supported for this action).');
      return;
    }

    setMultiPageRunning(true);
    try {
      const result = await runMultiPageParse(tab.id, targetDate, (progress) => {
        setMultiPageProgress(progress);
      });

      if (result.stopReason === 'auth_error') {
        setUser(null);
        setError('Please sign in again.');
      } else if (
        result.stopReason === 'glitch_error' ||
        result.stopReason === 'nav_error' ||
        result.stopReason === 'pagination_unsupported'
      ) {
        setError(result.errorMessage ?? 'Multi-page parse stopped unexpectedly.');
      } else if (result.stopReason === 'max_pages') {
        setMultiPageSummary(
          `Stopped at the ${MAX_PAGES}-page safety cap without reaching ${targetDate} — ` +
            `${result.pagesProcessed} page(s) processed, ${result.totalLeadsSaved} lead(s) saved. ` +
            'Re-run with a later target date, or run again to continue further back.',
        );
      } else {
        setMultiPageSummary(
          `Done — parsed ${result.pagesProcessed} page(s), saved ${result.totalLeadsSaved} lead(s), reached ${targetDate}.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMultiPageProgress(null);
      setMultiPageRunning(false);
    }
  };

  // CLAUDE.md scope D (Wellfound): a separate, dedicated flow from the block above — that one
  // stays Techjobs/ITjobs-only (exact publish dates to stop on). Wellfound only has relative
  // posted-time text, so this walks a fixed WELLFOUND_PAGINATION_BATCH_SIZE-page batch instead
  // of stopping on a date. Shared by both "Continue" and "Parse from here" below; they only
  // differ in how startPage is computed before calling this.
  const runWellfoundPageBatch = async (startPage: number, source: 'parse_from_here' | 'continue') => {
    // Synchronous guard, checked and set before any `await` — a second call (fast double-click,
    // or clicking the other button in the brief window before React re-renders and disables
    // the DOM buttons) hits this line before doing anything else and bails out immediately.
    // The wellfoundPageRunningSource state below drives the UI (disabled attribute, which
    // button shows "Parsing pages…") but its update isn't visible to the DOM synchronously, so
    // it alone can't close this race — see the ref's declaration.
    if (wellfoundPageRunningRef.current) return;
    wellfoundPageRunningRef.current = true;
    setWellfoundPageRunningSource(source);
    setError(null);
    setWellfoundPageSummary(null);

    let result: WellfoundPaginationResult | undefined;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let hostname = '';
      try {
        hostname = tab?.url ? new URL(tab.url).hostname : '';
      } catch {
        // leave hostname empty; falls through to the "not a Wellfound tab" error below
      }
      if (!tab?.url || hostname !== WELLFOUND_HOSTNAME) {
        setError('Open a Wellfound list page in this tab first.');
        return;
      }

      const baseUrl = stripPageParam(tab.url);

      result = await runWellfoundPagination(baseUrl, startPage, (progress) => {
        setWellfoundPageProgress(progress);
      });

      // Always overwrite (never merge) — "Parse from here" is an explicit override/safety
      // valve (CLAUDE.md-style design note above), and "Continue" advancing is just the same
      // write with a larger value. lastPageProcessed is startPage - 1 when nothing succeeded,
      // which is a harmless no-op write (next run starts at the same place either way).
      await setBookmark(baseUrl, result.lastPageProcessed);
      setWellfoundBookmark(await getBookmark(baseUrl));

      if (result.stopReason === 'auth_error') {
        setUser(null);
        setError('Please sign in again.');
      } else if (result.stopReason === 'window_closed') {
        setWellfoundPageSummary(
          result.pagesProcessed > 0
            ? `Wellfound pagination was interrupted — the background window was closed. ` +
                `Parsed pages ${result.startPage}-${result.lastPageProcessed} before that (${result.leadsFound} lead(s) found, ${result.leadsSaved} new); ` +
                'already-saved leads were kept. Click Continue to resume.'
            : `Wellfound pagination was interrupted — the background window was closed before page ${startPage} finished. ` +
                'Click Continue to resume.',
        );
      } else if (result.pagesProcessed === 0 && result.stopReason === 'no_more_pages') {
        setWellfoundPageSummary(`No results found starting from page ${startPage} — nothing to parse.`);
      } else if (result.stopReason === 'circuit_breaker') {
        const failedFrom = Math.max(startPage, result.lastPageAttempted - WELLFOUND_CIRCUIT_BREAKER_THRESHOLD + 1);
        setWellfoundPageSummary(
          `Parsed pages ${result.startPage}-${result.lastPageProcessed} (${result.leadsFound} lead(s) found, ${result.leadsSaved} new) — ` +
            `stopped after ${WELLFOUND_CIRCUIT_BREAKER_THRESHOLD} consecutive failures (pages ${failedFrom}-${result.lastPageAttempted}), ` +
            'possible bot-detection block. Leads already saved before the stop were kept. Use Continue to retry from where this left off.',
        );
      } else if (result.stopReason === 'no_more_pages') {
        setWellfoundPageSummary(
          `Parsed pages ${result.startPage}-${result.lastPageProcessed} — reached the end of this search's results ` +
            `(${result.leadsFound} lead(s) found, ${result.leadsSaved} new).`,
        );
      } else {
        setWellfoundPageSummary(
          `Parsed pages ${result.startPage}-${result.lastPageProcessed} — ${result.leadsFound} lead(s) found, ${result.leadsSaved} new.`,
        );
      }

      // Auto-deepen exactly what THIS run parsed and saved — result.savedLeads is scoped to
      // this run only (see runWellfoundPagination's own doc comment), never a broader "every
      // lead in the DB still missing a description" sweep. Not awaited, same fire-and-forget
      // pattern handleParse already uses for the single-page Wellfound flow: the pagination
      // UI state above clears normally while deepening continues independently, surfaced via
      // the existing wellfoundDeepening/wellfoundDeepenSummary hints (shared with that flow,
      // nothing new to render here).
      runWellfoundDeepen(result.savedLeads);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      wellfoundPageRunningRef.current = false;
      setWellfoundPageRunningSource(null);
      setWellfoundPageProgress(null);
    }
  };

  const handleWellfoundParseFromHere = () => {
    if (!wellfoundListTabUrl) {
      setError('Open a Wellfound list page in this tab first.');
      return;
    }
    runWellfoundPageBatch(currentPageFromTabUrl(wellfoundListTabUrl), 'parse_from_here');
  };

  const handleWellfoundContinue = () => {
    if (!wellfoundBookmark || !isBookmarkFresh(wellfoundBookmark)) return;
    runWellfoundPageBatch(wellfoundBookmark.lastPage + 1, 'continue');
  };

  // 19.08 call, point 6: the automated pagination flow below can surface far more new leads in
  // one run than a single deepenWellfoundLeads() call handles (its own WELLFOUND_RUN_CAP would
  // otherwise silently drop the rest — see runWellfoundAutoDeepenWaves' own doc comment). Wave-
  // based counterpart to runWellfoundDeepen above; kept separate rather than making that
  // function wave-aware too, since handleParse's single-page flow realistically never approaches
  // WELLFOUND_RUN_CAP in one run and shouldn't need to reason about multi-wave state.
  const runWellfoundAutoDeepen = (results: unknown): Promise<void> => {
    const items = Array.isArray(results) ? (results as LeadSaveResult[]) : [];
    const targets = items
      .filter((r) => r?.lead && !r.lead.description && !r.lead.enrichment_error)
      .map((r) => ({ id: r.lead.id, source_url: r.lead.source_url }));
    if (targets.length === 0) return Promise.resolve();

    setWellfoundAutoDeepenSummary(null);
    setWellfoundAutoDeepenProgress({
      waveIndex: 1,
      waveCount: Math.ceil(targets.length / WELLFOUND_RUN_CAP),
      current: 0,
      total: Math.min(targets.length, WELLFOUND_RUN_CAP),
      overallProcessed: 0,
      overallTotal: targets.length,
      succeeded: 0,
    });
    return runWellfoundAutoDeepenWaves(targets, (progress) => {
      setWellfoundAutoDeepenProgress(progress);
    })
      .then((result) => {
        // Every lead here was a brand-new save from this run (targets is built from
        // description-less saves), so published_at is null for all of them until a
        // successful deepen backfills it from the detail page's real datePosted — a lead
        // that doesn't succeed (still-pending retry, or a definitive 404 like a removed
        // posting) simply never gets one. Surfaced explicitly here — rather than letting the
        // manager discover it only by cross-checking the dashboard's Published Date filter
        // against a raw "N saved" count, which is what actually happened the first time this
        // ran (a 404'd posting had no date and silently didn't show under that filter).
        const missingDate = targets.length - result.succeeded;
        const dateCaveat =
          missingDate > 0
            ? ` ${targets.length} saved posting(s) needed deepening to get a real published date — ${missingDate} may still be ` +
              'missing one (pending a retry, or the posting turned out to be gone/blocked) and won\'t show under the dashboard\'s ' +
              'Published Date filter until then.'
            : '';
        if (result.interrupted) {
          setWellfoundAutoDeepenSummary(
            `Wellfound deepening was interrupted — the background window was closed. ` +
              `${result.succeeded} of ${result.processed} attempted lead(s) completed before that across ${result.waves} wave(s); ` +
              'already-saved leads were kept. Re-run "Parse", or use the dashboard\'s Enrich button, to retry the rest.' +
              dateCaveat,
          );
        } else if (result.stoppedEarly) {
          setWellfoundAutoDeepenSummary(
            `Wellfound deepening stopped after ${WELLFOUND_CIRCUIT_BREAKER_THRESHOLD} consecutive failures (wave ${result.waves}) — ` +
              `possible bot-detection block. ${result.succeeded} of ${result.processed} attempted lead(s) succeeded.` +
              dateCaveat,
          );
        } else {
          setWellfoundAutoDeepenSummary(
            `Wellfound deepening done — ${result.succeeded} of ${result.processed} lead(s) succeeded across ${result.waves} wave(s).` +
              dateCaveat,
          );
        }
      })
      .finally(() => setWellfoundAutoDeepenProgress(null));
  };

  // 19.08 call: fully automated Wellfound multi-page parse — one click, a date-range pick
  // upfront, then hands-off (see runWellfoundAutoPagination's own doc comment for the full
  // rationale, especially why it can't reuse Techjobs' chronological early-stop). Re-derives the
  // active tab fresh at click time (same as runWellfoundPageBatch above) rather than trusting
  // wellfoundListTabUrl directly, in case the manager switched tabs after picking a range.
  const handleWellfoundAutoParse = async () => {
    if (wellfoundAutoRunningRef.current) return;
    if (!wellfoundAutoRange) {
      setError('Pick a date range first.');
      return;
    }
    wellfoundAutoRunningRef.current = true;
    setWellfoundAutoRunning(true);
    setError(null);
    setWellfoundAutoSummary(null);
    setWellfoundAutoProgress(null);

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let hostname = '';
      try {
        hostname = tab?.url ? new URL(tab.url).hostname : '';
      } catch {
        // leave hostname empty; falls through to the "not a Wellfound tab" error below
      }
      if (!tab?.url || hostname !== WELLFOUND_HOSTNAME) {
        setError('Open a Wellfound list page in this tab first.');
        return;
      }

      const baseUrl = stripPageParam(tab.url);
      const result = await runWellfoundAutoPagination(baseUrl, wellfoundAutoRange, (progress) => {
        setWellfoundAutoProgress(progress);
      });

      if (result.stopReason === 'auth_error') {
        setUser(null);
        setError('Please sign in again.');
      } else if (result.stopReason === 'circuit_breaker') {
        setWellfoundAutoSummary(
          `Stopped after ${WELLFOUND_CIRCUIT_BREAKER_THRESHOLD} consecutive page failures — possible bot-detection block. ` +
            `Scanned ${result.postingsScanned} posting(s) across ${result.pagesProcessed} page(s) before that: ${result.postingsSaved} saved, ` +
            `${result.postingsSkippedOutOfRange} out of range. Already-saved leads were kept — re-run "Parse" later to continue.`,
        );
      } else if (result.stopReason === 'window_closed') {
        setWellfoundAutoSummary(
          `Interrupted — the background window was closed. Scanned ${result.postingsScanned} posting(s) across ${result.pagesProcessed} page(s) ` +
            `before that: ${result.postingsSaved} saved, ${result.postingsSkippedOutOfRange} out of range. Already-saved leads were kept.`,
        );
      } else if (result.stopReason === 'max_pages') {
        setWellfoundAutoSummary(
          `Hit the ${WELLFOUND_AUTO_PAGINATION_MAX_PAGES}-page safety cap (not the normal stop condition — this search unusually has that ` +
            `many pages, or something's wrong). ${result.postingsScanned} posting(s) scanned, ${result.postingsSaved} saved, ` +
            `${result.postingsSkippedOutOfRange} out of range.`,
        );
      } else {
        setWellfoundAutoSummary(
          `Done — scanned ${result.pagesProcessed} page(s), ${result.postingsScanned} posting(s): ${result.postingsSaved} saved, ` +
            `${result.postingsSkippedOutOfRange} out of range and skipped.`,
        );
      }

      // Not awaited — same fire-and-forget pattern as runWellfoundPageBatch above: the pagination
      // UI state clears normally while wave-based deepening continues independently.
      runWellfoundAutoDeepen(result.savedLeads);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      wellfoundAutoRunningRef.current = false;
      setWellfoundAutoRunning(false);
      setWellfoundAutoProgress(null);
    }
  };

  // 24.09 follow-up (deepening architecture fix): Indeed's equivalent of runWellfoundAutoDeepen
  // above — wraps indeed-deepen.ts's runIndeedAutoDeepenWaves (INDEED_DEEPEN_RUN_CAP-sized waves
  // with an anti-bot cooldown between them) instead of the plain runDeepen/deepenLeads this used
  // to call, now that FetchDeepening is confirmed 403'd by Indeed's anti-bot for every request.
  // No "missing published date" caveat the way Wellfound's version has: Indeed's published_at
  // already comes from the reliable list-parse createDate (parsers/indeed.ts), never backfilled
  // during deepening, so there's nothing for a deepen failure to leave missing on that front.
  const runIndeedAutoDeepen = (results: unknown): Promise<void> => {
    const targets = uniqueIndeedDeepenTargets(results);
    if (targets.length === 0) return Promise.resolve();

    setIndeedAutoDeepenSummary(null);
    setIndeedAutoDeepenProgress({
      waveIndex: 1,
      waveCount: Math.ceil(targets.length / INDEED_DEEPEN_RUN_CAP),
      current: 0,
      total: Math.min(targets.length, INDEED_DEEPEN_RUN_CAP),
      overallProcessed: 0,
      overallTotal: targets.length,
      succeeded: 0,
    });
    return runIndeedAutoDeepenWaves(targets, (progress) => {
      setIndeedAutoDeepenProgress(progress);
    })
      .then((result) => {
        if (result.interrupted) {
          setIndeedAutoDeepenSummary(
            `Indeed deepening was interrupted — the background window was closed. ` +
              `${result.succeeded} of ${result.processed} attempted lead(s) completed before that across ${result.waves} wave(s); ` +
              'already-saved leads were kept. Re-run "Parse", or use the dashboard\'s Enrich button, to retry the rest.',
          );
        } else if (result.stoppedEarly) {
          setIndeedAutoDeepenSummary(
            `Indeed deepening stopped after ${INDEED_CIRCUIT_BREAKER_THRESHOLD} consecutive failures (wave ${result.waves}) — ` +
              `possible bot-detection block. ${result.succeeded} of ${result.processed} attempted lead(s) succeeded.`,
          );
        } else {
          setIndeedAutoDeepenSummary(
            `Indeed deepening done — ${result.succeeded} of ${result.processed} lead(s) succeeded across ${result.waves} wave(s).`,
          );
        }
      })
      .finally(() => setIndeedAutoDeepenProgress(null));
  };

  // Indeed multi-region parse (02.10): from whichever Indeed domain is open, walks the same search
  // on every selected region (indeed-regions.ts) one after another — runIndeedMultiRegion, which
  // runs each region through the same runIndeedAutoPagination a single domain used (date-range
  // narrowing, next-link pagination, end-of-results detection), in that region's own time zone.
  // Auto-deepens everything saved afterward via runIndeedAutoDeepen — the real-background-tab wave
  // orchestrator (indeed-deepen.ts); a plain fetch is 403'd by Indeed. No Gemini here.
  const handleIndeedAutoParse = async () => {
    if (indeedAutoRunningRef.current) return;
    if (!indeedAutoRange) {
      setError('Pick a date range first.');
      return;
    }
    if (indeedSelectedRegionIds.length === 0) {
      setError('Select at least one Indeed region.');
      return;
    }
    indeedAutoRunningRef.current = true;
    setIndeedAutoRunning(true);
    setError(null);
    setIndeedAutoSummary(null);
    setIndeedRegionSummaries(null);
    setIndeedPageLog(null);
    setIndeedAutoProgress(null);

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let hostname = '';
      try {
        hostname = tab?.url ? new URL(tab.url).hostname : '';
      } catch {
        // leave hostname empty; falls through to the "not an Indeed tab" error below
      }
      if (!tab?.url || !isIndeedHost(hostname)) {
        setError('Open an Indeed list page in this tab first.');
        return;
      }

      // The open tab's own region first (its results show up soonest), then the rest in config order.
      const currentRegionId = findIndeedRegionByHost(hostname)?.id;
      const regions = INDEED_REGIONS.filter((r) => indeedSelectedRegionIds.includes(r.id)).sort(
        (x, y) => Number(y.id === currentRegionId) - Number(x.id === currentRegionId),
      );

      const run = await runIndeedMultiRegion(tab.url, regions, indeedAutoRange, setIndeedAutoProgress);

      setIndeedRegionSummaries(run.regions.map((r) => `${r.region.label}: ${summarizeIndeedRegion(r.result)}`));
      setIndeedPageLog(
        run.regions.flatMap((r) => r.result.pageLog.map((entry) => `${r.region.label} · ${formatIndeedPageLogEntry(entry)}`)),
      );

      const totals = run.regions.reduce(
        (acc, r) => ({
          scanned: acc.scanned + r.result.postingsScanned,
          saved: acc.saved + r.result.postingsSaved,
          known: acc.known + r.result.postingsAlreadyKnown,
          out: acc.out + r.result.postingsSkippedOutOfRange,
        }),
        { scanned: 0, saved: 0, known: 0, out: 0 },
      );
      const totalsText =
        `${totals.scanned} posting(s) scanned across ${run.regions.length} region(s): ${totals.saved} new, ` +
        `${totals.known} already in DB, ${totals.out} out of range.`;
      const skippedText = run.skippedRegions.length ? ` Not started: ${run.skippedRegions.map((r) => r.label).join(', ')}.` : '';

      if (run.stopReason === 'auth_error') {
        setUser(null);
        setError('Please sign in again.');
      } else if (run.stopReason === 'window_closed') {
        setIndeedAutoSummary(`Interrupted — the background window was closed. ${totalsText}${skippedText} Already-saved leads were kept.`);
      } else {
        setIndeedAutoSummary(`Done — ${totalsText}`);
      }

      // Not awaited — same fire-and-forget pattern as handleWellfoundAutoParse: the pagination UI
      // clears while deepening continues in its own background window.
      runIndeedAutoDeepen(run.savedLeads);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      indeedAutoRunningRef.current = false;
      setIndeedAutoRunning(false);
      setIndeedAutoProgress(null);
    }
  };

  if (!authChecked) {
    return (
      <div>
        <div className="theme-bar">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
        <div>Loading…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div>
        <div className="theme-bar">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
        <h1>Sales Manager — Leads</h1>
        <p className="hint">Sign in with Google to save leads to your Sheet.</p>
        <button className="parse-button" onClick={handleLogin} disabled={signingIn}>
          {signingIn ? 'Signing in…' : 'Sign in with Google'}
        </button>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  // Same "only render when the matching site is actually open" gating already used for
  // wellfoundListTabUrl below, generalized via activeHostname — see refreshActiveTabContext.
  const isTechjobsHost = activeHostname !== null && MULTIPAGE_HOSTNAMES.includes(activeHostname);

  return (
    <div>
      <div className="account-bar">
        <span>Signed in as {user.display_name}</span>
        <div className="account-bar-actions">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button onClick={handleLogout}>Sign out</button>
        </div>
      </div>

      <h1>Sales Manager — Leads</h1>

      {indeedHumanCheck && (
        <div className="parsing-banner human-check-banner" role="alert">
          ⚠ Indeed is showing a bot check (Cloudflare). Switch to the Indeed window and tick the checkbox — the run is paused
          and continues on its own afterwards (waits up to {INDEED_HUMAN_CHECK_WAIT_MS / 60000} min).
        </div>
      )}

      <div className="site-links">
        {QUICK_LAUNCH_SITES.map((site) => (
          <a key={site.url} className="site-link" href={site.url} target="_blank" rel="noreferrer">
            {site.label}
          </a>
        ))}
      </div>

      {tabSupported ? (
        <button className="parse-button" onClick={handleParse} disabled={parsing}>
          {parsing ? 'Parsing…' : 'Parse current list page'}
        </button>
      ) : (
        <div className="hint">Open a Techjobs.ca, ITjobs.ca, Wellfound, Indeed, or DevITjobs job list page to enable parsing.</div>
      )}
      {parsing && (
        <div className="parsing-banner" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          Parsing in progress — please stay on this page.
        </div>
      )}
      {deepening && (
        <div className="hint">Deepening {deepening.current}/{deepening.total}…</div>
      )}
      {deepenSummary && <div className="hint">{deepenSummary}</div>}
      {classifying && (
        <div className="hint">Classifying {classifying.current}/{classifying.total}…</div>
      )}
      {classifySummary && <div className="hint">{classifySummary}</div>}
      {wellfoundDeepening && (
        <div className="hint">
          Wellfound deepening {wellfoundDeepening.current}/{wellfoundDeepening.total} (background tab)…
        </div>
      )}
      {wellfoundDeepenSummary && <div className="hint">{wellfoundDeepenSummary}</div>}
      {indeedDeepening && (
        <div className="hint">
          Indeed deepening {indeedDeepening.current}/{indeedDeepening.total} (background tab)…
        </div>
      )}
      {indeedDeepenSummary && <div className="hint">{indeedDeepenSummary}</div>}

      {isTechjobsHost && (
        <div className="multipage-block">
          <label htmlFor="target-date">Parse Techjobs back to date</label>
          <div className="multipage-row">
            <input
              id="target-date"
              type="date"
              max={todayIso()}
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              disabled={multiPageRunning || parsing}
            />
            <button
              className="parse-button"
              onClick={handleMultiPageParse}
              disabled={!targetDate || multiPageRunning || parsing}
            >
              {multiPageRunning ? 'Parsing pages…' : 'Parse pages back to date'}
            </button>
          </div>
          <div className="hint">Techjobs.ca or ITjobs.ca only. Walks pages via ?page=N, up to {MAX_PAGES} pages. No Gemini here.</div>
          {multiPageProgress && (
            <div className="hint">
              Page {multiPageProgress.page}/{MAX_PAGES} · Deepening {multiPageProgress.deepenCurrent}/{multiPageProgress.deepenTotal}
            </div>
          )}
          {multiPageSummary && <div className="hint">{multiPageSummary}</div>}
        </div>
      )}

      {wellfoundListTabUrl && (
        <div className="multipage-block">
          <label>Parse Wellfound pages (auto, all pages)</label>
          <DateRangePicker value={wellfoundAutoRange} onChange={setWellfoundAutoRange} disabled={wellfoundAutoRunning} />
          <button
            className="parse-button"
            style={{ marginTop: 8 }}
            onClick={handleWellfoundAutoParse}
            disabled={!wellfoundAutoRange || wellfoundAutoRunning || parsing}
          >
            {wellfoundAutoRunning ? 'Parsing…' : 'Parse'}
          </button>
          <div className="hint">
            Wellfound only. Walks every page of the current search (no page cap) via ?page=N in a background tab, saving only
            postings whose (approximate) published date falls in the picked range — everything else is skipped immediately,
            never saved. Pauses ~{WELLFOUND_AUTO_BATCH_PAUSE_MIN_MS / 1000}-{WELLFOUND_AUTO_BATCH_PAUSE_MAX_MS / 1000}s every ~
            {WELLFOUND_AUTO_BATCH_POSTINGS} postings scanned to avoid anti-bot detection, then automatically deepens whatever it
            saved (in waves of {WELLFOUND_RUN_CAP} if there's a lot). No Gemini here.
          </div>
          {wellfoundAutoProgress && (
            <div className="hint">
              {wellfoundAutoProgress.phase === 'batch_pause'
                ? `Batch pause (anti-bot cooldown) — resuming automatically. ${wellfoundAutoProgress.postingsScanned} scanned, ` +
                  `${wellfoundAutoProgress.postingsSaved} saved, ${wellfoundAutoProgress.postingsSkippedOutOfRange} out of range so far.`
                : `Page ${wellfoundAutoProgress.page} · ${wellfoundAutoProgress.postingsScanned} scanned, ${wellfoundAutoProgress.postingsSaved} saved, ` +
                  `${wellfoundAutoProgress.postingsSkippedOutOfRange} out of range`}
            </div>
          )}
          {wellfoundAutoSummary && <div className="hint">{wellfoundAutoSummary}</div>}
          {wellfoundAutoDeepenProgress && (
            <div className="hint">
              Deepening wave {wellfoundAutoDeepenProgress.waveIndex}/{wellfoundAutoDeepenProgress.waveCount} —{' '}
              {wellfoundAutoDeepenProgress.overallProcessed}/{wellfoundAutoDeepenProgress.overallTotal} lead(s) overall,{' '}
              {wellfoundAutoDeepenProgress.succeeded} succeeded
            </div>
          )}
          {wellfoundAutoDeepenSummary && <div className="hint">{wellfoundAutoDeepenSummary}</div>}
        </div>
      )}

      {indeedListTabUrl && (
        <div className="multipage-block">
          <label>Parse Indeed — all regions (auto, all pages)</label>
          <RegionDropdown selectedIds={indeedSelectedRegionIds} onChange={setIndeedSelectedRegionIds} disabled={indeedAutoRunning} />
          <DateRangePicker value={indeedAutoRange} onChange={setIndeedAutoRange} disabled={indeedAutoRunning} />
          <button
            className="parse-button"
            style={{ marginTop: 8 }}
            onClick={handleIndeedAutoParse}
            disabled={!indeedAutoRange || indeedSelectedRegionIds.length === 0 || indeedAutoRunning || parsing}
          >
            {indeedAutoRunning ? 'Parsing…' : 'Parse'}
          </button>
          <div className="hint">
            Runs the search query from this tab on every selected Indeed region, one after another, always with location
            &quot;Remote&quot;. Saves only postings published in the picked range (judged in each region&apos;s own time zone);
            ranges starting within the last 14 days use Indeed&apos;s &quot;Date posted&quot; filter to keep runs short. Pauses
            between pages and {INDEED_REGION_PAUSE_MIN_MS / 1000}-{INDEED_REGION_PAUSE_MAX_MS / 1000}s between regions (shorter after
            single-page regions)
            (anti-bot). A region that hits a sign-in wall or bot check is skipped, the rest continue. Deepens everything saved
            afterward in a background tab. No Gemini here.
          </div>
          {indeedAutoProgress && (
            <div className="hint region-status">
              {indeedAutoProgress.phase === 'region_pause' ? (
                <div>
                  <strong>Pause:</strong> next region {indeedAutoProgress.nextRegion?.label} in{' '}
                  {Math.max(0, Math.ceil(((indeedAutoProgress.pauseUntil ?? nowTick) - nowTick) / 1000))}s (anti-bot cooldown)
                </div>
              ) : (
                <div>
                  <strong>Parsing:</strong> {indeedAutoProgress.region.label} ({indeedAutoProgress.regionIndex}/
                  {indeedAutoProgress.regionCount})
                </div>
              )}
              <div>
                {indeedAutoProgress.phase === 'region_pause'
                  ? null
                  : indeedAutoProgress.pagination
                    ? (indeedAutoProgress.phase === 'batch_pause' ? 'Batch pause · ' : '') +
                      `Page ${indeedAutoProgress.pagination.page} · ${indeedAutoProgress.pagination.postingsScanned} scanned, ` +
                      `${indeedAutoProgress.pagination.postingsSaved} new, ${indeedAutoProgress.pagination.postingsAlreadyKnown} already in DB, ` +
                      `${indeedAutoProgress.pagination.postingsSkippedOutOfRange} out of range`
                    : 'Starting…'}
              </div>
              {indeedAutoProgress.done.length > 0 && (
                <div>
                  <strong>Done:</strong> {indeedAutoProgress.done.map(formatIndeedRegionDone).join(', ')}
                </div>
              )}
              {indeedAutoProgress.queued.length > 0 && (
                <div>
                  <strong>Queued:</strong> {indeedAutoProgress.queued.map((r) => r.label).join(', ')}
                </div>
              )}
            </div>
          )}
          {indeedAutoSummary && <div className="hint">{indeedAutoSummary}</div>}
          {indeedRegionSummaries && indeedRegionSummaries.length > 0 && (
            <ul className="hint region-summary">
              {indeedRegionSummaries.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
          {indeedPageLog && indeedPageLog.length > 0 && (
            <details className="hint page-log" open>
              <summary>Page log ({indeedPageLog.length})</summary>
              <ol>
                {indeedPageLog.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ol>
            </details>
          )}
          {indeedAutoDeepenProgress && (
            <div className="hint">
              Deepening wave {indeedAutoDeepenProgress.waveIndex}/{indeedAutoDeepenProgress.waveCount} —{' '}
              {indeedAutoDeepenProgress.overallProcessed}/{indeedAutoDeepenProgress.overallTotal} lead(s) overall,{' '}
              {indeedAutoDeepenProgress.succeeded} succeeded
            </div>
          )}
          {indeedAutoDeepenSummary && <div className="hint">{indeedAutoDeepenSummary}</div>}
        </div>
      )}

      {SHOW_LEGACY_WELLFOUND_PAGINATION && wellfoundListTabUrl && (
        <div className="multipage-block">
          <label>Parse Wellfound pages (fixed batch)</label>
          <div className="multipage-row">
            <button
              className="parse-button"
              onClick={handleWellfoundParseFromHere}
              disabled={wellfoundPageRunningSource !== null || parsing}
            >
              {wellfoundPageRunningSource === 'parse_from_here'
                ? 'Parsing pages…'
                : `Parse from here (page ${currentPageFromTabUrl(wellfoundListTabUrl ?? '')})`}
            </button>
            {wellfoundBookmark && isBookmarkFresh(wellfoundBookmark) && (
              <button
                className="parse-button"
                onClick={handleWellfoundContinue}
                disabled={wellfoundPageRunningSource !== null || parsing}
              >
                {wellfoundPageRunningSource === 'continue' ? 'Parsing pages…' : `Continue (from page ${wellfoundBookmark.lastPage + 1})`}
              </button>
            )}
          </div>
          {wellfoundBookmark && !isBookmarkFresh(wellfoundBookmark) && (
            <div className="hint">Previous progress is from a different day — start a new run with "Parse from here".</div>
          )}
          <div className="hint">
            Wellfound only. Walks {WELLFOUND_PAGINATION_BATCH_SIZE} pages via ?page=N in a background tab, human-paced.
            Automatically deepens the leads this batch found afterward (own background window, capped at {WELLFOUND_RUN_CAP} —
            see the deepening progress below). No Gemini here.
          </div>
          {wellfoundPageProgress && (
            <div className="hint">
              Page {wellfoundPageProgress.page} (batch {wellfoundPageProgress.pageIndex}/{wellfoundPageProgress.batchSize}) ·{' '}
              {wellfoundPageProgress.leadsFound} found, {wellfoundPageProgress.leadsSaved} new
            </div>
          )}
          {wellfoundPageSummary && <div className="hint">{wellfoundPageSummary}</div>}
        </div>
      )}

      {error && <div className="error">{error}</div>}
    </div>
  );
}
