import { getToken } from '../lib/auth';
import { BACKEND_URL, isSupportedUrl } from '../lib/backend';

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
