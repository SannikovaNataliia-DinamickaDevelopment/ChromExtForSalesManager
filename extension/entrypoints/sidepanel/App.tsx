import { useEffect, useState } from 'react';
import { AuthError, fetchLeads, updateLeadStatus, type LeadSaveResult } from '../../lib/api';
import { fetchMe, login, logout, type CurrentUser } from '../../lib/auth';
import { classifyLeads, type ClassifyProgress } from '../../lib/classify';
import { deepenLeads, type DeepenProgress } from '../../lib/deepen';
import { formatKyivDate, formatKyivDateTime } from '../../lib/format-time';
import { MAX_PAGES, runMultiPageParse, type MultiPageProgress } from '../../lib/multipage';
import { STATUS_OPTIONS } from '../../lib/status-labels';
import {
  deepenWellfoundLeads,
  WELLFOUND_CIRCUIT_BREAKER_THRESHOLD,
  type WellfoundDeepenProgress,
} from '../../lib/wellfound-deepen';
import type { JobLeadRecord, LeadStatus } from '../../lib/types';

// Multi-page (scope D) only works on sites built on this template — confirmed identical
// pagination/card structure for both (CLAUDE.md "Parser spec"). DevITjobs stays out (paused).
const MULTIPAGE_HOSTNAMES = ['www.techjobs.ca', 'www.itjobs.ca'];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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

  useEffect(() => {
    fetchMe()
      .then((me) => {
        setUser(me);
        if (me) loadLeads();
      })
      .catch(handleAuthAware)
      .finally(() => setAuthChecked(true));

    refreshTabStatus();
    chrome.tabs.onActivated.addListener(refreshTabStatus);
    chrome.tabs.onUpdated.addListener(refreshTabStatus);
    return () => {
      chrome.tabs.onActivated.removeListener(refreshTabStatus);
      chrome.tabs.onUpdated.removeListener(refreshTabStatus);
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
        if (result.stoppedEarly) {
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
    return <div>Loading…</div>;
  }

  if (!user) {
    return (
      <div>
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
        <button onClick={handleLogout}>Sign out</button>
      </div>

      <h1>Sales Manager — Leads</h1>

      <button className="parse-button" onClick={handleParse} disabled={!tabSupported || parsing}>
        {parsing ? 'Parsing…' : 'Parse current list page'}
      </button>
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
            disabled={multiPageRunning}
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
