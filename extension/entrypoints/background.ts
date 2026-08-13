import { deepenLead } from '../lib/api';
import { getToken } from '../lib/auth';
import { BACKEND_URL, isSupportedUrl } from '../lib/backend';
import { FetchDeepening } from '../lib/deepen';
import { deepenWellfoundLeads, WELLFOUND_RUN_CAP } from '../lib/wellfound-deepen';

const BULK_ENRICH_PORT_NAME = 'enrich-bulk';

// Guards against two overlapping bulk runs (two dashboard tabs/windows, or a double-click that
// slipped past the UI's own disabled state) — the service worker is a single shared process, so
// a module-level flag is enough; a second connection is rejected outright rather than queued or
// interleaved with the first run's Wellfound circuit breaker/window.
let bulkEnrichInFlight = false;

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

  // Dashboard bulk "Enrich selected" — same externally_connectable channel as the single-lead
  // ENRICH_LEAD message above, but a long-lived Port instead of one-shot sendMessage, since
  // this needs to stream progress back over a run that can take minutes (Wellfound leads).
  // Reuses the exact same FetchDeepening/deepenWellfoundLeads as enrichLead() and the batch
  // "auto by all" flow — grouped by source, never a second Wellfound implementation.
  chrome.runtime.onConnectExternal.addListener((port) => {
    if (port.name !== BULK_ENRICH_PORT_NAME) return;

    port.onMessage.addListener((message) => {
      if (message?.type !== 'ENRICH_LEADS') return;

      const send = (msg: unknown) => {
        try {
          port.postMessage(msg);
        } catch {
          // Port already disconnected (dashboard tab closed/navigated away) — the run below
          // still finishes and writes to the backend, there's just no one left to tell.
        }
      };

      if (bulkEnrichInFlight) {
        send({ type: 'DONE', ok: false, error: 'A bulk enrich run is already in progress. Wait for it to finish and try again.' });
        port.disconnect();
        return;
      }

      bulkEnrichInFlight = true;
      enrichLeadsBulk(message.leads, (progress) => send({ type: 'PROGRESS', ...progress }))
        .then((result) => send({ type: 'DONE', ...result }))
        .catch((err) => send({ type: 'DONE', ok: false, error: err instanceof Error ? err.message : String(err) }))
        .finally(() => {
          bulkEnrichInFlight = false;
          try {
            port.disconnect();
          } catch {
            // Already gone.
          }
        });
    });
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
  const tabId = tab.id;

  const token = await getToken();
  if (!token) {
    return { ok: false as const, error: 'Not signed in.', authError: true as const };
  }

  // On-page "stay on this page" toast (content.ts) — spans the exact same work the side
  // panel's own .parsing-banner does (App.tsx's `parsing` state), shown here and hidden in
  // the finally below on every exit path (success, failure, content-script-unreachable).
  // Best-effort: if the content script can't be reached, the PARSE_LIST call right after this
  // fails the exact same way and surfaces its own error — the side panel banner already
  // covers that case either way, so a swallowed failure here is harmless, not a silent bug.
  await showParseOverlay(tabId);
  try {
    let parseResponse: { ok: boolean; leads?: unknown; error?: string } | undefined;
    try {
      parseResponse = await chrome.tabs.sendMessage(tabId, { type: 'PARSE_LIST' });
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
  } finally {
    await hideParseOverlay(tabId);
  }
}

async function showParseOverlay(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_PARSE_OVERLAY' });
  } catch {
    // See the comment above this call in parseActiveTab.
  }
}

async function hideParseOverlay(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'HIDE_PARSE_OVERLAY' });
  } catch {
    // Tab may have navigated away or closed by the time parsing finished — nothing to clean
    // up in that case (the old page's DOM, overlay included, is already gone with it).
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
    if (result.succeeded === 1) return { ok: true as const };
    // Distinguishes a definitive 404 (posting removed/expired, already flagged with
    // enrichment_error by deepenWellfoundLeads) from a genuine timeout/possible bot-detection
    // block — the two have different causes and the message shouldn't blur them together.
    return result.errorFlagged === 1
      ? { ok: false as const, error: 'This posting no longer exists on Wellfound (404) — flagged, not a bot-detection block.' }
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

interface BulkEnrichLeadInput {
  leadId: string;
  sourceSite: string;
  sourceUrl: string;
}

function normalizeBulkLeads(raw: unknown): BulkEnrichLeadInput[] {
  if (!Array.isArray(raw)) return [];
  const out: BulkEnrichLeadInput[] = [];
  for (const rawItem of raw) {
    const item = rawItem as { leadId?: unknown; sourceSite?: unknown; sourceUrl?: unknown } | null;
    const leadId = typeof item?.leadId === 'string' ? item.leadId : '';
    const sourceSite = typeof item?.sourceSite === 'string' ? item.sourceSite : '';
    const sourceUrl = typeof item?.sourceUrl === 'string' ? item.sourceUrl : '';
    if (leadId && sourceUrl) out.push({ leadId, sourceSite, sourceUrl });
  }
  return out;
}

interface BulkEnrichProgress {
  completed: number;
  total: number;
}

interface BulkEnrichResult {
  ok: true;
  succeeded: number;
  failed: number;
  // Never attempted this run, for two distinct reasons the dashboard reports separately:
  // over WELLFOUND_RUN_CAP vs. the circuit breaker tripping partway through the capped batch.
  skippedCapLeadIds: string[];
  skippedCircuitBreakerLeadIds: string[];
}

// Dashboard bulk "Enrich selected" (ENRICH_LEADS, plural — distinct from the single-lead
// ENRICH_LEAD handler above). Groups by sourceSite and reuses the exact same per-source
// deepening the single-lead path and the batch "auto by all" flow use: FetchDeepening for
// Techjobs/ITjobs (fast, no pacing needed for this button), and deepenWellfoundLeads() for
// Wellfound — its own human-pace delay, run cap, and circuit breaker are all reused unchanged,
// never a second Wellfound implementation.
async function enrichLeadsBulk(
  rawLeads: unknown,
  onProgress: (progress: BulkEnrichProgress) => void,
): Promise<BulkEnrichResult> {
  const leads = normalizeBulkLeads(rawLeads);

  const token = await getToken();
  if (!token) {
    throw new Error('Not signed in to the extension.');
  }

  const wellfoundLeads = leads.filter((l) => l.sourceSite === 'wellfound');
  const otherLeads = leads.filter((l) => l.sourceSite !== 'wellfound');

  const wellfoundCapped = wellfoundLeads.slice(0, WELLFOUND_RUN_CAP);
  const skippedCapLeadIds = wellfoundLeads.slice(WELLFOUND_RUN_CAP).map((l) => l.leadId);

  const total = otherLeads.length + wellfoundCapped.length;
  let completed = 0;
  let succeeded = 0;
  let failed = 0;

  // Techjobs/ITjobs: sequential FetchDeepening calls, same as enrichLead() at n=1 — no
  // between-lead delay (CLAUDE.md's human-pace requirement is for the anti-ban detail-page
  // walk in the auto-deepen flow, not this on-demand fetch path).
  const strategy = new FetchDeepening();
  for (const lead of otherLeads) {
    try {
      const detail = await strategy.deepenOne({ id: lead.leadId, source_url: lead.sourceUrl });
      if (detail) {
        await deepenLead(lead.leadId, {
          description: detail.description,
          company: detail.company,
          company_website: detail.company_website,
          ...(detail.published_at ? { published_at: detail.published_at } : {}),
        });
        succeeded++;
      } else {
        failed++;
      }
    } catch {
      // Swallow: one bad detail page must not abort the rest of the batch (NFR-12/13).
      failed++;
    }
    completed++;
    onProgress({ completed, total });
  }

  let skippedCircuitBreakerLeadIds: string[] = [];
  if (wellfoundCapped.length > 0) {
    const result = await deepenWellfoundLeads(
      wellfoundCapped.map((l) => ({ id: l.leadId, source_url: l.sourceUrl })),
      (progress) => onProgress({ completed: completed + progress.current, total }),
    );
    completed += result.processed;
    succeeded += result.succeeded;
    failed += result.processed - result.succeeded;
    if (result.stoppedEarly) {
      // The circuit breaker stopped before reaching the end of the capped batch — the
      // untried tail was never attempted, so it's a skip, not a failure.
      skippedCircuitBreakerLeadIds = wellfoundCapped.slice(result.processed).map((l) => l.leadId);
    }
  }

  return { ok: true, succeeded, failed, skippedCapLeadIds, skippedCircuitBreakerLeadIds };
}
