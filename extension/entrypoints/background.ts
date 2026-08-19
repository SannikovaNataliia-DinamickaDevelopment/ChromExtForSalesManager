import { deepenLead } from '../lib/api';
import { getToken } from '../lib/auth';
import { BACKEND_URL, isSupportedUrl } from '../lib/backend';
import { FetchDeepening } from '../lib/deepen';
import { deepenWellfoundLeads, runWellfoundAutoDeepenWaves, WELLFOUND_RUN_CAP } from '../lib/wellfound-deepen';
import { backfillWellfoundContact } from '../lib/wellfound-contact-backfill';

const BULK_ENRICH_PORT_NAME = 'enrich-bulk';

// Guards against two overlapping bulk runs — not just two ENRICH_LEADS runs, but any
// combination of ENRICH_LEADS and BACKFILL_CONTACT_LEADS, since both ultimately drive the same
// single dedicated Wellfound background window (WellfoundBackgroundWindow only ever expects one
// caller at a time). Two dashboard tabs/windows, or a double-click that slipped past the UI's
// own disabled state — the service worker is a single shared process, so a module-level flag is
// enough; a second connection is rejected outright rather than queued or interleaved with the
// first run's Wellfound circuit breaker/window.
let wellfoundBulkInFlight = false;

// Side panel liveness tracking (dashboard-triggered Wellfound enrichment guard). Wellfound
// deepening/backfill (TabDeepening/deepenWellfoundLeads) is human-paced with setTimeout-based
// delays that can add up to several minutes for a full run — MV3 service workers are NOT
// guaranteed to stay alive that long on their own (Chrome can suspend an idle-looking worker
// between messages, and a pending setTimeout does not reliably survive that the way
// chrome.alarms would). An open side panel is what actually keeps this service worker alive for
// the run's duration in practice (Chrome treats an open extension view as "still needed"); with
// it closed, a dashboard-triggered Wellfound run can get killed silently partway through, which
// is exactly the confusing "X failed" the dashboard shows today with no real explanation. Kept
// as a literal (not a shared import) rather than importing sidepanel/App.tsx here — same
// precedent as DASHBOARD_SESSION_COOKIE in backend/src/auth/auth.controller.ts/
// dashboard.controller.ts. Must match sidepanel/App.tsx's copy.
const SIDEPANEL_PORT_NAME = 'sidepanel-alive';
// A count, not a boolean — the side panel is per-window, so a manager can legitimately have it
// open in two Chrome windows at once; closing one must not flip this to "closed" while the
// other is still connected.
let openSidePanelCount = 0;
const sidePanelOpen = () => openSidePanelCount > 0;

const WELLFOUND_SIDEPANEL_REQUIRED_ERROR =
  "Open the extension's side panel first, then try again — Wellfound enrichment needs it open to keep running.";

// Coordinator (CLAUDE.md phase 1): resolves the active tab, asks its content
// script to parse the current list page, then forwards the batch to the
// local backend. Never touches other tabs, never auto-scrolls/pages (FR-5).
export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  });

  // See SIDEPANEL_PORT_NAME's comment above — sidepanel/App.tsx connects on mount and this
  // just tracks that connection's lifetime. onConnect (not onConnectExternal): the side panel
  // is part of this same extension, not an external origin like the dashboard.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== SIDEPANEL_PORT_NAME) return;
    openSidePanelCount++;
    port.onDisconnect.addListener(() => {
      openSidePanelCount--;
    });
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

  // Dashboard bulk "Enrich selected" / "Backfill contact selected" — same externally_connectable
  // channel as the single-lead ENRICH_LEAD message above, but a long-lived Port instead of
  // one-shot sendMessage, since both need to stream progress back over a run that can take
  // minutes (Wellfound leads). One port/listener handles both message types (rather than a
  // second port) since they share the exact same in-flight guard and window — see
  // wellfoundBulkInFlight's comment. Reuses the exact same FetchDeepening/deepenWellfoundLeads/
  // backfillWellfoundContact as enrichLead() and the batch "auto by all" flow — grouped by
  // source, never a second Wellfound implementation.
  chrome.runtime.onConnectExternal.addListener((port) => {
    if (port.name !== BULK_ENRICH_PORT_NAME) return;

    port.onMessage.addListener((message) => {
      if (message?.type !== 'ENRICH_LEADS' && message?.type !== 'BACKFILL_CONTACT_LEADS') return;

      const send = (msg: unknown) => {
        try {
          port.postMessage(msg);
        } catch {
          // Port already disconnected (dashboard tab closed/navigated away) — the run below
          // still finishes and writes to the backend, there's just no one left to tell.
        }
      };

      if (wellfoundBulkInFlight) {
        send({ type: 'DONE', ok: false, error: 'A bulk Wellfound run is already in progress. Wait for it to finish and try again.' });
        port.disconnect();
        return;
      }

      wellfoundBulkInFlight = true;
      const run =
        message.type === 'ENRICH_LEADS'
          ? enrichLeadsBulk(message.leads, (progress) => send({ type: 'PROGRESS', ...progress }))
          : backfillContactBulk(message.leads, (progress) => send({ type: 'PROGRESS', ...progress }));
      run
        .then((result) => send({ type: 'DONE', ...result }))
        .catch((err) => send({ type: 'DONE', ok: false, error: err instanceof Error ? err.message : String(err) }))
        .finally(() => {
          wellfoundBulkInFlight = false;
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
    if (!sidePanelOpen()) {
      return { ok: false as const, error: WELLFOUND_SIDEPANEL_REQUIRED_ERROR };
    }
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
  // Never attempted this run because the whole Wellfound wave sequence stopped early (circuit
  // breaker inside a wave, or the background window closed) — the untried tail, not a failure.
  // No run-cap concept applies here any more (see this function's own doc comment below), so
  // there's no separate "skipped for being over the cap" bucket the way there used to be.
  skippedCircuitBreakerLeadIds: string[];
}

// Dashboard bulk "Enrich selected" (ENRICH_LEADS, plural — distinct from the single-lead
// ENRICH_LEAD handler above). Groups by sourceSite and reuses the exact same per-source
// deepening the single-lead path and the batch "auto by all" flow use: FetchDeepening for
// Techjobs/ITjobs (fast, no pacing needed for this button — unchanged, was never capped), and
// (19.08 follow-up) runWellfoundAutoDeepenWaves for Wellfound — the SAME wave+cooldown-pause
// orchestrator the automated multi-page pagination flow's auto-deepen step uses
// (wellfound-pagination.ts calls it from the side panel; this is the same plain async function
// called directly from here instead — it has no side-panel/DOM dependencies of its own, only
// what deepenWellfoundLeads already needed, which this file already imports and calls
// elsewhere, so no adapter was needed). Replaces the old single deepenWellfoundLeads() call that
// silently capped a selection at WELLFOUND_RUN_CAP and dropped the rest — the FULL Wellfound
// selection is now processed automatically in WELLFOUND_RUN_CAP-sized waves with a cooldown
// pause between them, no re-trigger needed. Company LinkedIn and LPR search are untouched —
// separate features, never routed through this bulk-enrich path.
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

  // Checked upfront, before any work (Techjobs/ITjobs included) starts — see
  // SIDEPANEL_PORT_NAME's comment above for why. A mixed selection with the panel closed
  // rejects the whole request rather than silently doing the non-Wellfound portion and
  // failing only the Wellfound part; same "reject the whole request outright" shape as the
  // wellfoundBulkInFlight guard just above this function's call site. The panel now needs to
  // stay open for potentially longer (an uncapped selection can span several waves), same
  // requirement as before, just for more of it.
  if (wellfoundLeads.length > 0 && !sidePanelOpen()) {
    throw new Error(WELLFOUND_SIDEPANEL_REQUIRED_ERROR);
  }

  const total = otherLeads.length + wellfoundLeads.length;
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
  if (wellfoundLeads.length > 0) {
    const result = await runWellfoundAutoDeepenWaves(
      wellfoundLeads.map((l) => ({ id: l.leadId, source_url: l.sourceUrl })),
      (progress) => onProgress({ completed: completed + progress.overallProcessed, total }),
    );
    completed += result.processed;
    succeeded += result.succeeded;
    failed += result.processed - result.succeeded;
    if (result.stoppedEarly) {
      // The wave sequence stopped before reaching the end of the full selection (a circuit
      // breaker inside one wave, or the background window closed) — the untried tail was
      // never attempted, so it's a skip, not a failure.
      skippedCircuitBreakerLeadIds = wellfoundLeads.slice(result.processed).map((l) => l.leadId);
    }
  }

  return { ok: true, succeeded, failed, skippedCircuitBreakerLeadIds };
}

interface BulkContactResult {
  ok: true;
  found: number;
  notSpecified: number;
  // Definitive 404s, timeouts/blocks, and save failures — see backfillWellfoundContact's own
  // doc comment. Left as 'not_checked' on the lead, so a later run retries them.
  unresolved: number;
  skippedCapLeadIds: string[];
  skippedCircuitBreakerLeadIds: string[];
}

// Dashboard bulk "Backfill contact selected" (BACKFILL_CONTACT_LEADS). Wellfound-only by
// construction — the dashboard only ever offers this button for Wellfound leads still
// hiring_contact_status === 'not_checked' (see dashboard-page.ts's getSelectedNeedsContactCheck),
// but this filters defensively too rather than trusting the caller. Reuses
// backfillWellfoundContact (wellfound-contact-backfill.ts) unchanged — same cap/circuit-breaker/
// pacing as every other Wellfound bulk action, never a second implementation.
async function backfillContactBulk(
  rawLeads: unknown,
  onProgress: (progress: BulkEnrichProgress) => void,
): Promise<BulkContactResult> {
  const leads = normalizeBulkLeads(rawLeads).filter((l) => l.sourceSite === 'wellfound');

  const token = await getToken();
  if (!token) {
    throw new Error('Not signed in to the extension.');
  }

  const capped = leads.slice(0, WELLFOUND_RUN_CAP);
  const skippedCapLeadIds = leads.slice(WELLFOUND_RUN_CAP).map((l) => l.leadId);
  const total = capped.length;

  if (capped.length === 0) {
    return { ok: true, found: 0, notSpecified: 0, unresolved: 0, skippedCapLeadIds, skippedCircuitBreakerLeadIds: [] };
  }

  // See SIDEPANEL_PORT_NAME's comment above — same upfront guard as enrichLeadsBulk, checked
  // only once there's actually eligible Wellfound work to do (an empty/fully-capped-out
  // selection returns above without needing the panel at all).
  if (!sidePanelOpen()) {
    throw new Error(WELLFOUND_SIDEPANEL_REQUIRED_ERROR);
  }

  const result = await backfillWellfoundContact(
    capped.map((l) => ({ id: l.leadId, source_url: l.sourceUrl })),
    (progress) => onProgress({ completed: progress.current, total }),
  );

  // Same "stoppedEarly means an untried tail, not a failure" reasoning as enrichLeadsBulk above
  // — covers both the circuit breaker tripping and the background window being closed mid-run.
  const skippedCircuitBreakerLeadIds = result.stoppedEarly
    ? capped.slice(result.processed).map((l) => l.leadId)
    : [];

  return {
    ok: true,
    found: result.found,
    notSpecified: result.notSpecified,
    unresolved: result.unresolved,
    skippedCapLeadIds,
    skippedCircuitBreakerLeadIds,
  };
}
