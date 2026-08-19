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
];

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
  useEffect(() => {
    const port = chrome.runtime.connect({ name: SIDEPANEL_PORT_NAME });
    return () => port.disconnect();
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
        return;
      }
      setWellfoundListTabUrl(tab.url);
      getBookmark(stripPageParam(tab.url)).then(setWellfoundBookmark);
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
  const runDeepen = (results: unknown): Promise<void> => {
    const items = Array.isArray(results) ? (results as LeadSaveResult[]) : [];
    const targets = items
      .filter((r) => r?.lead && !r.lead.description && !r.lead.enrichment_error)
      .map((r) => ({ id: r.lead.id, source_url: r.lead.source_url }));
    if (targets.length === 0) return Promise.resolve();

    setDeepening({ current: 0, total: targets.length });
    return deepenLeads(targets, (progress) => {
      setDeepening(progress);
    }).finally(() => setDeepening(null));
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
        if (isWellfound) {
          runWellfoundDeepen(results);
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
        <div className="hint">Open a Techjobs.ca, ITjobs.ca, Wellfound, or DevITjobs job list page to enable parsing.</div>
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
