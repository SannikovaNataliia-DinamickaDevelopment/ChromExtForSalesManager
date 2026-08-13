import { useEffect, useRef, useState } from 'react';
import { AuthError, fetchLeads, updateLeadStatus, type LeadSaveResult } from '../../lib/api';
import { fetchMe, login, logout, type CurrentUser } from '../../lib/auth';
import { classifyLeads, type ClassifyProgress } from '../../lib/classify';
import { deepenLeads, type DeepenProgress } from '../../lib/deepen';
import { formatKyivDate, formatKyivDateTime } from '../../lib/format-time';
import { MAX_PAGES, runMultiPageParse, type MultiPageProgress } from '../../lib/multipage';
import { STATUS_OPTIONS } from '../../lib/status-labels';
import { getStoredTheme, setStoredTheme, type Theme } from '../../lib/theme';
import {
  deepenWellfoundLeads,
  WELLFOUND_CIRCUIT_BREAKER_THRESHOLD,
  type WellfoundDeepenProgress,
} from '../../lib/wellfound-deepen';
import {
  getBookmark,
  setBookmark,
  stripPageParam,
  type WellfoundPaginationBookmark,
} from '../../lib/wellfound-pagination-bookmark';
import {
  runWellfoundPagination,
  WELLFOUND_PAGINATION_BATCH_SIZE,
  type WellfoundPaginationProgress,
  type WellfoundPaginationResult,
} from '../../lib/wellfound-pagination';
import type { JobLeadRecord, LeadStatus } from '../../lib/types';

// Multi-page (scope D) only works on sites built on this template — confirmed identical
// pagination/card structure for both (CLAUDE.md "Parser spec"). DevITjobs stays out (paused).
const MULTIPAGE_HOSTNAMES = ['www.techjobs.ca', 'www.itjobs.ca'];

// Separate, dedicated Wellfound-only list-pagination flow (see wellfound-pagination.ts) — not
// the MULTIPAGE_HOSTNAMES block above, which stays Techjobs/ITjobs-only.
const WELLFOUND_HOSTNAME = 'wellfound.com';

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
  const [leads, setLeads] = useState<JobLeadRecord[]>([]);
  const [tabSupported, setTabSupported] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [loading, setLoading] = useState(false);
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
  // Default is dark, matching the dashboard's current (only) look, until/unless the user's
  // stored choice loads from chrome.storage.local (see lib/theme.ts).
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    getStoredTheme().then((stored) => {
      if (stored) setTheme(stored);
    });
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

  const loadLeads = () => {
    setLoading(true);
    fetchLeads()
      .then(setLeads)
      .catch(handleAuthAware)
      .finally(() => setLoading(false));
  };

  const refreshTabStatus = () => {
    chrome.runtime.sendMessage({ type: 'GET_TAB_STATUS' }).then((res) => {
      setTabSupported(!!res?.supported);
    });
  };

  // Keeps the "Continue" button's enabled/shown state (and its target page label) in sync with
  // whichever Wellfound search context is currently open in the active tab — same trigger
  // points (tab activated/updated) as refreshTabStatus above, just scoped to Wellfound and to
  // whether a pagination bookmark exists for THIS search's base URL (page param stripped).
  const refreshWellfoundContext = () => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      let hostname = '';
      try {
        hostname = tab?.url ? new URL(tab.url).hostname : '';
      } catch {
        // leave hostname empty; falls through to the "not a Wellfound tab" branch below
      }
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
        if (me) loadLeads();
      })
      .catch(handleAuthAware)
      .finally(() => setAuthChecked(true));

    refreshTabStatus();
    refreshWellfoundContext();
    chrome.tabs.onActivated.addListener(refreshTabStatus);
    chrome.tabs.onUpdated.addListener(refreshTabStatus);
    chrome.tabs.onActivated.addListener(refreshWellfoundContext);
    chrome.tabs.onUpdated.addListener(refreshWellfoundContext);
    return () => {
      chrome.tabs.onActivated.removeListener(refreshTabStatus);
      chrome.tabs.onUpdated.removeListener(refreshTabStatus);
      chrome.tabs.onActivated.removeListener(refreshWellfoundContext);
      chrome.tabs.onUpdated.removeListener(refreshWellfoundContext);
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
      if (me) loadLeads();
    } finally {
      setSigningIn(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setLeads([]);
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
      loadLeads();
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
  const runDeepen = (results: unknown): Promise<void> => {
    const items = Array.isArray(results) ? (results as LeadSaveResult[]) : [];
    const targets = items
      .filter((r) => r?.lead && !r.lead.description)
      .map((r) => ({ id: r.lead.id, source_url: r.lead.source_url }));
    if (targets.length === 0) return Promise.resolve();

    setDeepening({ current: 0, total: targets.length });
    return deepenLeads(targets, (progress) => {
      setDeepening(progress);
      loadLeads();
    }).finally(() => setDeepening(null));
  };

  // CLAUDE.md scope D (Wellfound): TabDeepening instead of the plain-fetch strategy above —
  // Wellfound's DataDome bot-protection blocks a background fetch outright (confirmed via a
  // real curl: HTTP 403 challenge page). Deliberately does NOT chain into runClassify —
  // Gemini stays off for Wellfound leads.
  const runWellfoundDeepen = (results: unknown): Promise<void> => {
    const items = Array.isArray(results) ? (results as LeadSaveResult[]) : [];
    const targets = items
      .filter((r) => r?.lead && !r.lead.description)
      .map((r) => ({ id: r.lead.id, source_url: r.lead.source_url }));
    if (targets.length === 0) return Promise.resolve();

    setWellfoundDeepenSummary(null);
    setWellfoundDeepening({ current: 0, total: targets.length, succeeded: 0, stoppedEarly: false });
    return deepenWellfoundLeads(targets, (progress) => {
      setWellfoundDeepening(progress);
      loadLeads();
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
        loadLeads();
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
        loadLeads();
      });

      if (result.stopReason === 'auth_error') {
        setUser(null);
        setError('Please sign in again.');
      } else if (result.stopReason === 'glitch_error' || result.stopReason === 'nav_error') {
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
      loadLeads();
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
        loadLeads();
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      wellfoundPageRunningRef.current = false;
      setWellfoundPageRunningSource(null);
      setWellfoundPageProgress(null);
      loadLeads();
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
    if (!wellfoundBookmark) return;
    runWellfoundPageBatch(wellfoundBookmark.lastPage + 1, 'continue');
  };

  const handleStatusChange = async (id: string, status: LeadStatus) => {
    const previous = leads;
    setLeads((current) => current.map((lead) => (lead.id === id ? { ...lead, status } : lead)));
    try {
      await updateLeadStatus(id, status);
    } catch (err) {
      setLeads(previous);
      handleAuthAware(err);
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

      <button className="parse-button" onClick={handleParse} disabled={!tabSupported || parsing}>
        {parsing ? 'Parsing…' : 'Parse current list page'}
      </button>
      {parsing && (
        <div className="parsing-banner" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          Parsing in progress — please stay on this page.
        </div>
      )}
      {!tabSupported && (
        <div className="hint">Open a Techjobs.ca, ITjobs.ca, Wellfound, or DevITjobs job list page to enable parsing.</div>
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
            disabled={!tabSupported || !targetDate || multiPageRunning || parsing}
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

      {wellfoundListTabUrl && (
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
                : `Parse from here (page ${currentPageFromTabUrl(wellfoundListTabUrl)})`}
            </button>
            {wellfoundBookmark && (
              <button
                className="parse-button"
                onClick={handleWellfoundContinue}
                disabled={wellfoundPageRunningSource !== null || parsing}
              >
                {wellfoundPageRunningSource === 'continue' ? 'Parsing pages…' : `Continue (from page ${wellfoundBookmark.lastPage + 1})`}
              </button>
            )}
          </div>
          <div className="hint">
            Wellfound only. Walks {WELLFOUND_PAGINATION_BATCH_SIZE} pages via ?page=N in a background tab, human-paced. No
            deepening, no Gemini here — newly found leads can be enriched later from the dashboard.
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

      <div className="lead-list">
        {loading && <div>Loading…</div>}
        {!loading && leads.length === 0 && <div className="hint">No leads yet.</div>}
        {leads.map((lead) => (
          <div className="lead-card" key={lead.id}>
            <div className="title">
              {lead.job_title || '(untitled)'}
              {lead.is_it !== 'unprocessed' && (
                <span className={`is-it-badge ${lead.is_it}`}>{lead.is_it === 'it' ? 'IT' : 'not-IT'}</span>
              )}
              {lead.owner_user_id !== user.id && (
                <span className="owner-badge">by {lead.owner_display_name || lead.owner_email || 'someone else'}</span>
              )}
            </div>
            <div className="meta">{lead.company || '—'} · {lead.location || '—'}</div>
            {lead.company_website && (
              <a className="meta" href={lead.company_website} target="_blank" rel="noreferrer">
                {lead.company_website}
              </a>
            )}
            <div className="meta">Posted: {lead.published_at ? formatKyivDate(lead.published_at) : '—'}</div>
            <div className="meta">{formatKyivDateTime(lead.scraped_at || lead.created_at)}</div>
            <a href={lead.source_url} target="_blank" rel="noreferrer">
              {lead.source_url}
            </a>
            <select
              value={lead.status}
              onChange={(e) => handleStatusChange(lead.id, e.target.value as LeadStatus)}
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
