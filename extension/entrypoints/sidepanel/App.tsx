import { useEffect, useState } from 'react';
import { AuthError, fetchLeads, updateLeadStatus } from '../../lib/api';
import { fetchMe, login, logout, type CurrentUser } from '../../lib/auth';
import { formatKyivDate, formatKyivDateTime } from '../../lib/format-time';
import { STATUS_OPTIONS } from '../../lib/status-labels';
import type { JobLeadRecord, LeadStatus } from '../../lib/types';

export default function App() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [leads, setLeads] = useState<JobLeadRecord[]>([]);
  const [tabSupported, setTabSupported] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      {error && <div className="error">{error}</div>}

      <div className="lead-list">
        {loading && <div>Loading…</div>}
        {!loading && leads.length === 0 && <div className="hint">No leads yet.</div>}
        {leads.map((lead) => (
          <div className="lead-card" key={lead.id}>
            <div className="title">
              {lead.job_title || '(untitled)'}
              {lead.owner_user_id !== user.id && (
                <span className="owner-badge">by {lead.owner_display_name || lead.owner_email || 'someone else'}</span>
              )}
            </div>
            <div className="meta">{lead.company || '—'} · {lead.location || '—'}</div>
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
