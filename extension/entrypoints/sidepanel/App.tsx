import { useEffect, useState } from 'react';
import { AuthError, fetchLeads, updateLeadStatus } from '../../lib/api';
import { fetchMe, login, logout, type CurrentUser } from '../../lib/auth';
import { classifyLeads, type ClassifyProgress } from '../../lib/classify';
import { deepenLeads, type DeepenProgress } from '../../lib/deepen';
import { formatKyivDate, formatKyivDateTime } from '../../lib/format-time';
import { STATUS_OPTIONS } from '../../lib/status-labels';
import type { JobLeadRecord, LeadStatus } from '../../lib/types';

// Shape of each item in PARSE_ACTIVE_TAB's `results` (mirrors backend LeadSaveResult);
// message-passing across chrome.runtime.sendMessage isn't typed, so this is asserted, not inferred.
interface LeadSaveResult {
  lead: JobLeadRecord;
  deduplicated: boolean;
  destination: 'ok' | 'failed';
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
    const targets = fresh.filter((l) => l.description && l.is_it === 'unprocessed').map((l) => ({ id: l.id }));
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
        runDeepen(res.results).then(runClassify);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
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
        <div className="hint">Open a Techjobs.ca or DevITjobs job list page to enable parsing.</div>
      )}
      {deepening && (
        <div className="hint">Deepening {deepening.current}/{deepening.total}…</div>
      )}
      {classifying && (
        <div className="hint">Classifying {classifying.current}/{classifying.total}…</div>
      )}
      {classifySummary && <div className="hint">{classifySummary}</div>}
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
