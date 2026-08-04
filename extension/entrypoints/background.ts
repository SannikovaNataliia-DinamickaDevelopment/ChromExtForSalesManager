import { deepenLead } from '../lib/api';
import { getToken } from '../lib/auth';
import { BACKEND_URL, isSupportedUrl } from '../lib/backend';
import { FetchDeepening } from '../lib/deepen';
import { deepenWellfoundLeads } from '../lib/wellfound-deepen';

// Coordinator (CLAUDE.md phase 1): resolves the active tab, asks its content
// script to parse the current list page, then forwards the batch to the
// local backend. Never touches other tabs, never auto-scrolls/pages (FR-5).
export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GET_TAB_STATUS') {
      getTabStatus()
        .then(sendResponse)
        .catch(() => sendResponse({ supported: false }));
      return true;
    }
    if (message?.type === 'PARSE_ACTIVE_TAB') {
      // Without this .catch, a rejected promise here (e.g. chrome.tabs.sendMessage
      // finding no content-script listener) leaves sendResponse uncalled and the
      // side panel's "Parsing…" spinner hangs forever with no error surfaced.
      parseActiveTab()
        .then(sendResponse)
        .catch((err) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
      return true;
    }
    return undefined;
  });

  // Dashboard "Enrich" button: an on-demand, single-lead entry point into the SAME
  // DeepeningStrategy implementations the batch "auto by all" flow uses (deepen.ts's
  // FetchDeepening, wellfound-deepen.ts's TabDeepening/deepenWellfoundLeads) — not a new
  // deepening mechanism. Only reachable from origins declared in externally_connectable
  // (wxt.config.ts — currently just the local dashboard). Gemini is never invoked here.
  chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'ENRICH_LEAD') return undefined;
    enrichLead(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  });
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getTabStatus() {
  const tab = await getActiveTab();
  return { supported: isSupportedUrl(tab?.url) };
}

async function parseActiveTab() {
  const tab = await getActiveTab();
  if (!tab?.id || !isSupportedUrl(tab.url)) {
    return { ok: false as const, error: 'Active tab is not a supported job site.' };
  }

  const token = await getToken();
  if (!token) {
    return { ok: false as const, error: 'Not signed in.', authError: true as const };
  }

  let parseResponse: { ok: boolean; leads?: unknown; error?: string } | undefined;
  try {
    parseResponse = await chrome.tabs.sendMessage(tab.id, { type: 'PARSE_LIST' });
  } catch {
    // No content-script listener on the other end — typically because this tab was
    // already open before the extension was (re)loaded, so its content script is
    // running against an invalidated extension context.
    return {
      ok: false as const,
      error: 'Could not reach the page. Reload the Techjobs.ca tab and try parsing again.',
    };
  }
  if (!parseResponse?.ok) {
    return { ok: false as const, error: parseResponse?.error ?? 'Parsing failed.' };
  }

  const leads = parseResponse.leads;
  if (!Array.isArray(leads) || leads.length === 0) {
    return { ok: true as const, leadCount: 0, results: [] };
  }

  try {
    const res = await fetch(`${BACKEND_URL}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(leads),
    });
    if (res.status === 401) {
      return { ok: false as const, error: 'Session expired. Please sign in again.', authError: true as const };
    }
    const data = await res.json();
    if (!res.ok) {
      return { ok: false as const, error: data?.error?.message ?? 'Backend rejected the batch.' };
    }
    return { ok: true as const, leadCount: leads.length, results: data };
  } catch (err) {
    return { ok: false as const, error: `Could not reach backend: ${err instanceof Error ? err.message : String(err)}` };
  }
}

interface EnrichLeadMessage {
  leadId?: unknown;
  sourceSite?: unknown;
  sourceUrl?: unknown;
}

async function enrichLead(message: EnrichLeadMessage) {
  const leadId = typeof message.leadId === 'string' ? message.leadId : '';
  const sourceSite = typeof message.sourceSite === 'string' ? message.sourceSite : '';
  const sourceUrl = typeof message.sourceUrl === 'string' ? message.sourceUrl : '';
  if (!leadId || !sourceUrl) {
    return { ok: false as const, error: 'Missing leadId or sourceUrl.' };
  }

  const token = await getToken();
  if (!token) {
    return { ok: false as const, error: 'Not signed in to the extension.', authError: true as const };
  }

  // Wellfound: reuse the exact batch orchestration (deepenWellfoundLeads) at n=1 — its
  // dedicated background window, circuit breaker, and human-pace delay are all harmless
  // (and mostly no-ops) for a single lead, but reusing the real function means this path
  // can never silently drift from the batch flow's behavior.
  if (sourceSite === 'wellfound') {
    const result = await deepenWellfoundLeads([{ id: leadId, source_url: sourceUrl }], () => {});
    return result.succeeded === 1
      ? { ok: true as const }
      : { ok: false as const, error: 'Could not enrich this Wellfound lead (bot-detection block or timeout).' };
  }

  // Techjobs/ITjobs (and any other future fetch-reachable source): FetchDeepening directly.
  // Its batch wrapper (deepen.ts's deepenLeads) only adds a between-lead delay and progress
  // callbacks — both moot at n=1 — so there's no orchestration worth going through here.
  const strategy = new FetchDeepening();
  const detail = await strategy.deepenOne({ id: leadId, source_url: sourceUrl });
  if (!detail) {
    return { ok: false as const, error: 'Could not read the detail page for this lead.' };
  }

  await deepenLead(leadId, {
    description: detail.description,
    company: detail.company,
    company_website: detail.company_website,
    ...(detail.published_at ? { published_at: detail.published_at } : {}),
  });
  return { ok: true as const };
}
