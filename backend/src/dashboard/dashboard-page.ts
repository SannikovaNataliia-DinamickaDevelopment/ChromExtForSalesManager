// Additive, self-contained dashboard feature (see module docstring in dashboard.module.ts).
// Everything — markup, dark theme, and the client-side table logic — lives in this one
// template function so the whole feature is just this folder + a couple of small, clearly
// marked hooks in the auth module.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderDashboardPage(opts: { authError?: string }): string {
  const authErrorHtml = opts.authError
    ? `<div class="auth-error">Sign-in error: ${escapeHtml(opts.authError)}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Leads Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #1A1420;
    --panel: #211826;
    --panel-alt: #271d2e;
    --accent: #A78BC4;
    --accent-2: #8B7BB8;
    --pink: #C97FB0;
    --text: #FFFFFF;
    --text-secondary: #D9D6DE;
    --border: rgba(167, 139, 196, 0.25);
    /* Dedicated danger/error red, distinct from --pink (used elsewhere for normal brand UI —
       buttons, badges, hover states — so it doesn't read as "error" on its own). Same value
       as the side panel's dark-mode --error (extension/entrypoints/sidepanel/style.css) —
       one product, one error color. ~5:1 contrast against --bg/--panel, passes WCAG AA. */
    --error: #F2555A;
    --error-bg: rgba(242, 85, 90, 0.15);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Poppins', system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }
  .page { max-width: 1400px; margin: 0 auto; padding: 24px 28px 60px; }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 18px;
    flex-wrap: wrap;
    gap: 12px;
  }
  h1 {
    font-size: 20px;
    font-weight: 600;
    color: var(--accent);
    margin: 0;
    letter-spacing: 0.2px;
  }
  .signout-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    padding: 6px 14px;
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
  }
  .signout-btn:hover { border-color: var(--pink); color: var(--pink); }
  .ext-id-field {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    margin-right: 12px;
  }
  .ext-id-field label {
    color: var(--text-secondary);
    font-size: 12px;
  }
  .ext-id-field input {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 5px 8px;
    font-family: inherit;
    font-size: 12px;
    width: 220px;
  }
  .ext-id-field input:focus { outline: 1px solid var(--accent); }
  .auth-error {
    background: var(--error-bg);
    border: 1px solid var(--error);
    color: var(--error);
    padding: 10px 14px;
    border-radius: 8px;
    margin-bottom: 16px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .toolbar label {
    color: var(--text-secondary);
    font-size: 12px;
    margin-right: 6px;
  }
  .toolbar select, .toolbar button.refresh {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 10px;
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .toolbar select:focus, .toolbar button.refresh:focus { outline: 1px solid var(--accent); }
  .count {
    color: var(--text-secondary);
    font-size: 12px;
    margin-left: auto;
  }
  .bulk-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    padding: 10px 14px;
    background: rgba(201, 127, 176, 0.12);
    border: 1px solid var(--pink);
    border-radius: 10px;
  }
  .bulk-bar[hidden] { display: none; }
  .bulk-bar .bulk-count { color: var(--text); font-size: 13px; font-weight: 500; }
  .bulk-bar button {
    background: var(--pink);
    color: #1A1420;
    border: none;
    border-radius: 8px;
    padding: 6px 14px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .bulk-bar button:disabled { cursor: not-allowed; opacity: 0.6; }
  .bulk-bar .bulk-status { color: var(--text-secondary); font-size: 12px; }
  td.checkbox-cell, th.checkbox-cell { width: 34px; text-align: center; padding-left: 14px; padding-right: 4px; }
  td.checkbox-cell input, th.checkbox-cell input { cursor: pointer; }
  td.checkbox-cell input:disabled, th.checkbox-cell input:disabled { cursor: not-allowed; }
  .table-wrap {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: auto;
    max-height: 76vh;
  }
  table { border-collapse: collapse; width: 100%; min-width: 980px; }
  thead th {
    position: sticky;
    top: 0;
    background: var(--panel-alt);
    color: var(--accent);
    text-align: left;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    padding: 10px 12px;
    cursor: pointer;
    white-space: nowrap;
    border-bottom: 1px solid var(--border);
    user-select: none;
  }
  thead th:hover { color: var(--pink); }
  thead th .arrow { color: var(--pink); margin-left: 4px; font-size: 10px; }
  tbody td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
    color: var(--text-secondary);
  }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: rgba(167, 139, 196, 0.1); }
  tbody tr:hover td { color: var(--text); }
  tbody tr:last-child td { border-bottom: none; }
  td.title-cell { color: var(--text); font-weight: 500; }
  a.website-link { color: var(--accent); text-decoration: none; }
  a.website-link:hover { color: var(--pink); text-decoration: underline; }
  .badge {
    display: inline-block;
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
  }
  .badge.it { background: rgba(201, 127, 176, 0.22); color: var(--pink); }
  .badge.not_it { background: rgba(217, 214, 222, 0.12); color: var(--text-secondary); }
  .badge.source { background: rgba(167, 139, 196, 0.16); color: var(--accent); text-transform: uppercase; }
  .empty-state, .loading-state {
    padding: 40px;
    text-align: center;
    color: var(--text-secondary);
  }

  /* Detail sidebar */
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(10, 6, 14, 0.6);
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.2s ease;
    z-index: 40;
  }
  .backdrop.open { opacity: 1; visibility: visible; }
  .sidebar {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(480px, 92vw);
    background: var(--panel);
    border-left: 1px solid var(--border);
    box-shadow: -12px 0 32px rgba(0, 0, 0, 0.45);
    transform: translateX(100%);
    transition: transform 0.25s ease;
    z-index: 50;
    overflow-y: auto;
    padding: 30px 28px 48px;
  }
  .sidebar.open { transform: translateX(0); }
  .sidebar-close {
    position: absolute;
    top: 16px;
    right: 16px;
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 6px;
  }
  .sidebar-close:hover { color: var(--pink); background: rgba(201, 127, 176, 0.12); }
  .sidebar-title {
    color: var(--accent);
    font-size: 19px;
    font-weight: 600;
    margin: 0 36px 6px 0;
    line-height: 1.35;
  }
  .sidebar-badge { margin-bottom: 18px; }
  .enrich-block {
    margin-bottom: 20px;
    padding: 12px;
    background: rgba(139, 123, 182, 0.1);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .enrich-btn {
    background: var(--pink);
    color: #1A1420;
    border: none;
    border-radius: 8px;
    padding: 7px 16px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .enrich-btn:hover { opacity: 0.9; }
  .enrich-btn:disabled { cursor: not-allowed; opacity: 0.6; }
  .enrich-status {
    margin-top: 8px;
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  .detail-row {
    display: flex;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .detail-label {
    flex: 0 0 100px;
    color: var(--accent-2);
    font-weight: 500;
  }
  .detail-value { color: var(--text-secondary); word-break: break-word; }
  .sidebar-desc-label {
    margin-top: 24px;
    margin-bottom: 10px;
    color: var(--accent);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-weight: 600;
  }
  .sidebar-desc {
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text);
    line-height: 1.75;
    font-size: 14px;
    max-width: 60ch;
  }
</style>
</head>
<body>
<div class="page">
  <div class="topbar">
    <h1>Leads Dashboard</h1>
    <span class="ext-id-field">
      <label for="extension-id">Extension ID</label>
      <input type="text" id="extension-id" placeholder="see chrome://extensions" autocomplete="off" spellcheck="false">
    </span>
    <button class="signout-btn" id="signout-btn" type="button">Sign out</button>
  </div>
  ${authErrorHtml}
  <div class="toolbar">
    <span>
      <label for="filter-is-it">IT filter</label>
      <select id="filter-is-it">
        <option value="all">All</option>
        <option value="it">IT</option>
        <option value="not_it">not-IT</option>
        <option value="unprocessed">Unprocessed</option>
      </select>
    </span>
    <span>
      <label for="filter-source">Source</label>
      <select id="filter-source">
        <option value="all">All</option>
      </select>
    </span>
    <span>
      <label for="filter-status">Status</label>
      <select id="filter-status">
        <option value="all">All</option>
        <option value="new">новий</option>
        <option value="in_progress">опрацьовується</option>
        <option value="done">опрацьований</option>
      </select>
    </span>
    <span>
      <label for="filter-detail">Detail</label>
      <select id="filter-detail">
        <option value="all">All</option>
        <option value="not_detailed">Not detailed</option>
        <option value="detailed">Detailed</option>
      </select>
    </span>
    <button class="refresh" id="refresh-btn" type="button">Refresh</button>
    <span class="count" id="count"></span>
  </div>
  <div class="bulk-bar" id="bulk-bar" hidden>
    <span class="bulk-count" id="bulk-count"></span>
    <button id="bulk-enrich-btn" type="button">Enrich selected</button>
    <span class="bulk-status" id="bulk-status"></span>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr id="header-row"></tr>
      </thead>
      <tbody id="table-body">
        <tr><td class="loading-state" colspan="9">Loading leads…</td></tr>
      </tbody>
    </table>
  </div>
</div>
<div class="backdrop" id="backdrop"></div>
<aside class="sidebar" id="sidebar" aria-hidden="true">
  <button class="sidebar-close" id="sidebar-close" type="button" aria-label="Close">&times;</button>
  <div id="sidebar-content"></div>
</aside>
<script>
(function () {
  var COOKIE_NAME = 'sm_dashboard_session';
  var STATUS_LABELS = { new: 'новий', in_progress: 'опрацьовується', done: 'опрацьований' };
  var IS_IT_LABELS = { it: 'IT', not_it: 'not-IT', unprocessed: '' };
  var COLUMN_COUNT = 12; // 11 data columns + the leading checkbox column
  // "Enrich" button (extension-side deepening triggered from this page — see background.ts's
  // ENRICH_LEAD handler). Each dev/browser loads the extension with its own id
  // (chrome://extensions), so this can't be hardcoded — the manager pastes it in once and
  // it's remembered in this browser.
  var EXTENSION_ID_STORAGE_KEY = 'sm_extension_id';
  // Safety net only — a real "not installed/not reachable" failure surfaces via
  // chrome.runtime.lastError almost immediately, not via this timeout. This just guards
  // against the callback never firing at all (worst case: nav timeout 30s + settle 1s +
  // extract timeout 20s for Wellfound, so must stay comfortably above that).
  var ENRICH_TIMEOUT_MS = 60000;
  // Leads currently being enriched, keyed by id — checked both to disable the button
  // immediately on click AND to re-render it disabled if the sidebar is closed and
  // reopened for the same lead while a request is still in flight.
  var enrichingLeadIds = {};
  var currentSidebarLeadId = null;

  // Bulk "Enrich selected" (extension messaging over a long-lived Port — see background.ts's
  // ENRICH_LEADS handler, chrome.runtime.onConnectExternal). A Port, not one-shot sendMessage
  // like the single-lead ENRICH_LEAD button, because a bulk run streams progress back over what
  // can be minutes of Wellfound tab-deepening.
  var BULK_ENRICH_PORT_NAME = 'enrich-bulk';
  var bulkState = {
    selected: {}, // leadId -> true
    inFlight: false,
    completed: 0,
    total: 0,
    status: '',
  };

  var COLUMNS = [
    { key: 'published_at', label: 'Published' },
    { key: 'source_site', label: 'Source' },
    { key: 'job_title', label: 'Title' },
    { key: 'source_url', label: 'Job link' },
    { key: 'is_it', label: 'IT?' },
    { key: 'company', label: 'Company' },
    { key: 'company_website', label: 'Website' },
    { key: 'location', label: 'Location' },
    { key: 'status', label: 'Status' },
    { key: 'owner', label: 'Owner' },
    { key: 'scraped_at', label: 'Scraped' },
  ];

  var state = {
    leads: [],
    sortKey: 'published_at',
    sortDir: 'desc',
    filterIsIt: 'all',
    filterStatus: 'all',
    filterSource: 'all',
    filterDetail: 'all',
  };

  function getCookie(name) {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      var eq = p.indexOf('=');
      if (eq === -1) continue;
      if (p.slice(0, eq) === name) return decodeURIComponent(p.slice(eq + 1));
    }
    return null;
  }

  function clearCookieAndGoToLogin() {
    document.cookie = COOKIE_NAME + '=; Max-Age=0; path=/';
    window.location.href = '/auth/login?for=dashboard';
  }

  function formatKyiv(value, dateOnly) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '';
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: dateOnly ? undefined : '2-digit',
      minute: dateOnly ? undefined : '2-digit',
      hour12: false,
    }).formatToParts(d);
    var get = function (type) {
      for (var i = 0; i < parts.length; i++) if (parts[i].type === type) return parts[i].value;
      return '';
    };
    if (dateOnly) return get('year') + '-' + get('month') + '-' + get('day');
    return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute');
  }

  function isSafeUrl(url) {
    return typeof url === 'string' && /^https?:\\/\\//i.test(url);
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      for (var key in props) {
        if (key === 'className') node.className = props[key];
        else if (key === 'text') node.textContent = props[key];
        else node.setAttribute(key, props[key]);
      }
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  // Header "select all currently filtered" checkbox — scoped to the not-detailed rows in the
  // current filter, same set clicking each row checkbox individually would reach.
  function buildSelectAllTh() {
    var th = document.createElement('th');
    th.className = 'checkbox-cell';
    var checkable = getCheckableFiltered();
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = bulkState.inFlight || checkable.length === 0;
    var selectedCount = checkable.filter(function (l) { return bulkState.selected[l.id]; }).length;
    checkbox.checked = checkable.length > 0 && selectedCount === checkable.length;
    checkbox.indeterminate = selectedCount > 0 && selectedCount < checkable.length;
    checkbox.addEventListener('click', function (e) { e.stopPropagation(); });
    checkbox.addEventListener('change', function () {
      checkable.forEach(function (l) {
        if (checkbox.checked) bulkState.selected[l.id] = true;
        else delete bulkState.selected[l.id];
      });
      bulkState.status = '';
      render();
    });
    th.appendChild(checkbox);
    return th;
  }

  function renderHeader() {
    var row = document.getElementById('header-row');
    row.innerHTML = '';
    row.appendChild(buildSelectAllTh());
    COLUMNS.forEach(function (col) {
      var th = document.createElement('th');
      th.textContent = col.label;
      th.addEventListener('click', function () { setSort(col.key); });
      if (state.sortKey === col.key) {
        var arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = state.sortDir === 'asc' ? '\\u25B2' : '\\u25BC';
        th.appendChild(arrow);
      }
      row.appendChild(th);
    });
  }

  function setSort(key) {
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = 'asc';
    }
    render();
  }

  function sortValue(lead, key) {
    if (key === 'owner') return (lead.owner_display_name || lead.owner_email || '').toLowerCase();
    var v = lead[key];
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v.toLowerCase() : v;
  }

  function getFiltered() {
    return state.leads.filter(function (lead) {
      if (state.filterIsIt !== 'all' && lead.is_it !== state.filterIsIt) return false;
      if (state.filterStatus !== 'all' && lead.status !== state.filterStatus) return false;
      if (state.filterSource !== 'all' && lead.source_site !== state.filterSource) return false;
      if (state.filterDetail !== 'all') {
        var notDetailed = needsEnrich(lead);
        if (state.filterDetail === 'not_detailed' && !notDetailed) return false;
        if (state.filterDetail === 'detailed' && notDetailed) return false;
      }
      return true;
    });
  }

  // Rows eligible for bulk selection — same "not detailed" definition the single-lead Enrich
  // button and the Detail filter both use (needsEnrich), scoped to whatever's currently
  // filtered/visible so "select all" never grabs a hidden row.
  function getCheckableFiltered() {
    return getFiltered().filter(needsEnrich);
  }

  function clearSelection() {
    bulkState.selected = {};
  }

  function selectedCount() {
    return Object.keys(bulkState.selected).length;
  }

  // Source options aren't a fixed enum like IT/Status (new sources get added over time — see
  // CLAUDE.md Parser spec history) — derive them from whatever's actually in the loaded data
  // instead of hardcoding a list that would silently go stale the next time a source is added.
  function populateSourceOptions() {
    var select = document.getElementById('filter-source');
    var previous = select.value || state.filterSource;
    var sources = Array.from(new Set(state.leads.map(function (l) { return l.source_site; }).filter(Boolean))).sort();

    select.innerHTML = '';
    select.appendChild(el('option', { value: 'all', text: 'All' }));
    sources.forEach(function (s) {
      select.appendChild(el('option', { value: s, text: s }));
    });

    var stillValid = previous === 'all' || sources.indexOf(previous) !== -1;
    var next = stillValid ? previous : 'all';
    select.value = next;
    state.filterSource = next;
  }

  function buildDetailRow(label, value, isLink) {
    var row = document.createElement('div');
    row.className = 'detail-row';
    row.appendChild(el('span', { className: 'detail-label', text: label }));
    if (isLink && isSafeUrl(value)) {
      var a = el('a', { className: 'website-link', href: value, target: '_blank', rel: 'noreferrer' });
      a.textContent = value;
      row.appendChild(a);
    } else {
      row.appendChild(el('span', { className: 'detail-value', text: value || '\\u2014' }));
    }
    return row;
  }

  // Compact link cell for the table (e.g. "Open ↗" rather than the full URL, so a long
  // source_url/company_website doesn't bloat the row). stopPropagation so clicking the link
  // navigates without also opening the row's detail sidebar underneath it.
  function buildLinkTd(url, linkText) {
    var td = document.createElement('td');
    if (isSafeUrl(url)) {
      var a = el('a', { className: 'website-link', href: url, target: '_blank', rel: 'noreferrer', text: linkText });
      a.addEventListener('click', function (e) { e.stopPropagation(); });
      td.appendChild(a);
    } else {
      td.textContent = '\\u2014';
    }
    return td;
  }

  // Only one sidebar exists — opening a new lead just replaces its content, so there's
  // never more than one open at a time.
  // Shown only for leads that fell out of deepening entirely (never attempted, failed, or
  // timed out) — a lead with either field already populated has nothing this button would add.
  function needsEnrich(lead) {
    return !lead.description && !lead.company_website;
  }

  function buildEnrichBlock(lead) {
    var wrap = document.createElement('div');
    wrap.className = 'enrich-block';

    var inFlight = !!enrichingLeadIds[lead.id];
    var button = el('button', { className: 'enrich-btn', type: 'button', text: inFlight ? 'Enriching…' : 'Enrich' });
    button.disabled = inFlight;
    var statusEl = el('div', { className: 'enrich-status' });

    button.addEventListener('click', function () {
      startEnrich(lead, button, statusEl);
    });

    wrap.appendChild(button);
    wrap.appendChild(statusEl);
    return wrap;
  }

  // Extension messaging (background.ts's ENRICH_LEAD handler) — reuses the extension's own
  // DeepeningStrategy implementations; this page never talks to Techjobs/ITjobs/Wellfound or
  // Gemini directly. enrichingLeadIds plus the button's own disabled state double up as
  // double-click protection: the native disabled attribute blocks a second click on the same
  // button instance, and the id-keyed set covers closing and reopening the sidebar for the
  // same lead while a request is still in flight (a fresh button is rendered pre-disabled).
  function startEnrich(lead, button, statusEl) {
    if (enrichingLeadIds[lead.id]) return;

    var extId = (localStorage.getItem(EXTENSION_ID_STORAGE_KEY) || '').trim();
    if (!extId) {
      statusEl.textContent = 'Set the Extension ID above first (see chrome://extensions), then try again.';
      return;
    }
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      statusEl.textContent = 'Install or open the Sales Manager extension in this browser to enrich leads.';
      return;
    }

    enrichingLeadIds[lead.id] = true;
    button.disabled = true;
    button.textContent = 'Enriching…';
    statusEl.textContent = '';

    var settled = false;
    var timeoutId = setTimeout(function () {
      finish({ ok: false, error: 'Timed out waiting for the extension — it may still be working in the background. Try Refresh shortly.' });
    }, ENRICH_TIMEOUT_MS);

    function finish(response) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      delete enrichingLeadIds[lead.id];

      if (!response || !response.ok) {
        button.disabled = false;
        button.textContent = 'Enrich';
        var message = (response && response.error) || 'Install or open the Sales Manager extension in this browser to enrich leads.';
        if (response && response.authError) message = 'Sign in to the extension first (open its side panel), then try again.';
        statusEl.textContent = message;
        return;
      }

      statusEl.textContent = 'Enriched \\u2014 refreshing\\u2026';
      loadLeads().then(function () {
        if (currentSidebarLeadId !== lead.id) return;
        var updated = state.leads.filter(function (l) { return l.id === lead.id; })[0];
        if (updated) openSidebar(updated);
      });
    }

    try {
      chrome.runtime.sendMessage(extId, { type: 'ENRICH_LEAD', leadId: lead.id, sourceSite: lead.source_site, sourceUrl: lead.source_url }, function (response) {
        if (chrome.runtime.lastError && !response) {
          finish({ ok: false, error: 'Install or open the Sales Manager extension in this browser to enrich leads.' });
          return;
        }
        finish(response);
      });
    } catch (err) {
      finish({ ok: false, error: 'Install or open the Sales Manager extension in this browser to enrich leads.' });
    }
  }

  function openSidebar(lead) {
    currentSidebarLeadId = lead.id;
    var content = document.getElementById('sidebar-content');
    content.innerHTML = '';
    content.appendChild(el('h2', { className: 'sidebar-title', text: lead.job_title || '(untitled)' }));

    var isItLabel = IS_IT_LABELS[lead.is_it];
    if (isItLabel) {
      content.appendChild(el('div', { className: 'sidebar-badge' }, [
        el('span', { className: 'badge ' + lead.is_it, text: isItLabel }),
      ]));
    }

    if (needsEnrich(lead)) {
      content.appendChild(buildEnrichBlock(lead));
    }

    content.appendChild(buildDetailRow('Company', lead.company));
    content.appendChild(buildDetailRow('Website', lead.company_website, true));
    content.appendChild(buildDetailRow('Job link', lead.source_url, true));
    content.appendChild(buildDetailRow('Location', lead.location));
    content.appendChild(buildDetailRow('Published', formatKyiv(lead.published_at, true)));
    content.appendChild(buildDetailRow('Source', lead.source_site));
    content.appendChild(buildDetailRow('Status', STATUS_LABELS[lead.status] || lead.status));
    content.appendChild(buildDetailRow('Owner', lead.owner_display_name || lead.owner_email));
    content.appendChild(buildDetailRow('Scraped', formatKyiv(lead.scraped_at || lead.created_at, false)));

    content.appendChild(el('div', { className: 'sidebar-desc-label', text: 'Description' }));
    content.appendChild(el('div', { className: 'sidebar-desc', text: lead.description || 'No description yet.' }));

    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar').setAttribute('aria-hidden', 'false');
    document.getElementById('backdrop').classList.add('open');
  }

  function closeSidebar() {
    currentSidebarLeadId = null;
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar').setAttribute('aria-hidden', 'true');
    document.getElementById('backdrop').classList.remove('open');
  }

  // Bulk-select checkbox — rendered only for rows matching the same "not detailed" definition
  // as the single-lead Enrich button (needsEnrich); a lead that already has description +
  // company_website has nothing this checkbox would add, so its cell stays empty.
  function buildCheckboxTd(lead) {
    var td = document.createElement('td');
    td.className = 'checkbox-cell';
    if (!needsEnrich(lead)) return td;

    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = bulkState.inFlight;
    checkbox.checked = !!bulkState.selected[lead.id];
    checkbox.addEventListener('click', function (e) { e.stopPropagation(); });
    checkbox.addEventListener('change', function () {
      if (checkbox.checked) bulkState.selected[lead.id] = true;
      else delete bulkState.selected[lead.id];
      bulkState.status = '';
      render();
    });
    td.appendChild(checkbox);
    return td;
  }

  function buildRow(lead) {
    var tr = document.createElement('tr');
    tr.addEventListener('click', function () { openSidebar(lead); });

    tr.appendChild(buildCheckboxTd(lead));
    tr.appendChild(el('td', { text: formatKyiv(lead.published_at, true) || '\\u2014' }));

    var sourceTd = document.createElement('td');
    if (lead.source_site) {
      sourceTd.appendChild(el('span', { className: 'badge source', text: lead.source_site }));
    } else {
      sourceTd.textContent = '\\u2014';
    }
    tr.appendChild(sourceTd);

    tr.appendChild(el('td', { className: 'title-cell', text: lead.job_title || '(untitled)' }));
    tr.appendChild(buildLinkTd(lead.source_url, 'Open \\u2197'));

    var isItTd = document.createElement('td');
    var isItLabel = IS_IT_LABELS[lead.is_it];
    if (isItLabel) {
      isItTd.appendChild(el('span', { className: 'badge ' + lead.is_it, text: isItLabel }));
    } else {
      isItTd.textContent = '\\u2014';
    }
    tr.appendChild(isItTd);

    tr.appendChild(el('td', { text: lead.company || '\\u2014' }));
    tr.appendChild(buildLinkTd(lead.company_website, lead.company_website));

    tr.appendChild(el('td', { text: lead.location || '\\u2014' }));
    tr.appendChild(el('td', { text: STATUS_LABELS[lead.status] || lead.status }));
    tr.appendChild(el('td', { text: lead.owner_display_name || lead.owner_email || '\\u2014' }));
    tr.appendChild(el('td', { text: formatKyiv(lead.scraped_at || lead.created_at, false) || '\\u2014' }));

    return tr;
  }

  // Drops selections for leads that no longer qualify (freshly enriched elsewhere, deleted,
  // or gone after a reload) — keeps them across filter/sort changes otherwise, since those
  // don't change what's actually selected, only what's currently visible.
  function pruneSelection() {
    var stillCheckable = {};
    state.leads.forEach(function (lead) { if (needsEnrich(lead)) stillCheckable[lead.id] = true; });
    Object.keys(bulkState.selected).forEach(function (id) {
      if (!stillCheckable[id]) delete bulkState.selected[id];
    });
  }

  function renderBulkBar() {
    var bar = document.getElementById('bulk-bar');
    var count = selectedCount();

    if (count === 0 && !bulkState.inFlight && !bulkState.status) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;

    var countEl = document.getElementById('bulk-count');
    var button = document.getElementById('bulk-enrich-btn');
    var statusEl = document.getElementById('bulk-status');

    countEl.textContent = bulkState.inFlight
      ? 'Enriching ' + bulkState.completed + '/' + bulkState.total + '\\u2026'
      : count + ' selected';
    button.textContent = 'Enrich selected (' + count + ')';
    button.disabled = bulkState.inFlight || count === 0;
    statusEl.textContent = bulkState.status;
  }

  function render() {
    pruneSelection();
    renderHeader();
    var filtered = getFiltered().slice();
    filtered.sort(function (a, b) {
      var av = sortValue(a, state.sortKey);
      var bv = sortValue(b, state.sortKey);
      if (av < bv) return state.sortDir === 'asc' ? -1 : 1;
      if (av > bv) return state.sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    var body = document.getElementById('table-body');
    body.innerHTML = '';
    if (filtered.length === 0) {
      body.appendChild(el('tr', {}, [el('td', { colspan: String(COLUMN_COUNT), className: 'empty-state', text: 'No leads match the current filters.' })]));
    } else {
      filtered.forEach(function (lead) { body.appendChild(buildRow(lead)); });
    }

    document.getElementById('count').textContent = filtered.length + ' of ' + state.leads.length + ' leads';
    renderBulkBar();
  }

  // Returns the fetch chain (not just fired-and-forgotten) so callers that need to act on
  // freshly-loaded data — e.g. re-rendering the sidebar after an Enrich call succeeds — can
  // chain onto it instead of guessing when state.leads has updated.
  function loadLeads() {
    var token = getCookie(COOKIE_NAME);
    if (!token) { clearCookieAndGoToLogin(); return Promise.resolve(); }

    return fetch('/leads', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (res) {
        if (res.status === 401) { clearCookieAndGoToLogin(); return null; }
        if (!res.ok) throw new Error('Request failed (' + res.status + ')');
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        state.leads = data;
        populateSourceOptions();
        render();
      })
      .catch(function (err) {
        var body = document.getElementById('table-body');
        body.innerHTML = '';
        body.appendChild(el('tr', {}, [el('td', { colspan: String(COLUMN_COUNT), className: 'empty-state', text: 'Failed to load leads: ' + err.message })]));
      });
  }

  function buildBulkSummary(result) {
    if (!result || !result.ok) {
      return (result && result.error) || 'Bulk enrich failed.';
    }
    var parts = [result.succeeded + ' succeeded'];
    if (result.failed) parts.push(result.failed + ' failed');
    var capSkipped = (result.skippedCapLeadIds || []).length;
    var breakerSkipped = (result.skippedCircuitBreakerLeadIds || []).length;
    if (capSkipped + breakerSkipped > 0) {
      var reasons = [];
      if (capSkipped) reasons.push('run cap reached');
      if (breakerSkipped) reasons.push('repeated Wellfound failures, stopped early');
      parts.push((capSkipped + breakerSkipped) + ' skipped \\u2014 ' + reasons.join('; '));
    }
    return parts.join(', ');
  }

  // Bulk "Enrich selected" — background.ts's ENRICH_LEADS handler (chrome.runtime.onConnectExternal,
  // BULK_ENRICH_PORT_NAME), a long-lived Port rather than one-shot sendMessage so the run (which
  // can take minutes for Wellfound leads) can stream PROGRESS back before the final DONE. Reuses
  // the same extension-id lookup and "not reachable" fallback text as the single-lead startEnrich().
  function startBulkEnrich() {
    if (bulkState.inFlight) return;

    var targets = getCheckableFiltered()
      .filter(function (l) { return bulkState.selected[l.id]; })
      .map(function (l) { return { leadId: l.id, sourceSite: l.source_site, sourceUrl: l.source_url }; });
    if (targets.length === 0) return;

    var extId = (localStorage.getItem(EXTENSION_ID_STORAGE_KEY) || '').trim();
    if (!extId) {
      bulkState.status = 'Set the Extension ID above first (see chrome://extensions), then try again.';
      render();
      return;
    }
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.connect) {
      bulkState.status = 'Install or open the Sales Manager extension in this browser to enrich leads.';
      render();
      return;
    }

    bulkState.inFlight = true;
    bulkState.completed = 0;
    bulkState.total = targets.length;
    bulkState.status = '';
    render();

    var settled = false;
    var timeoutId = setTimeout(function () {
      finish({ ok: false, error: 'Timed out waiting for the extension — it may still be working in the background. Try Refresh shortly.' });
    }, Math.max(ENRICH_TIMEOUT_MS, ENRICH_TIMEOUT_MS * targets.length));

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      bulkState.inFlight = false;
      bulkState.status = buildBulkSummary(result);
      clearSelection();
      render();
      loadLeads();
    }

    var port;
    try {
      port = chrome.runtime.connect(extId, { name: BULK_ENRICH_PORT_NAME });
    } catch (err) {
      finish({ ok: false, error: 'Install or open the Sales Manager extension in this browser to enrich leads.' });
      return;
    }

    port.onMessage.addListener(function (message) {
      if (!message) return;
      if (message.type === 'PROGRESS') {
        bulkState.completed = message.completed;
        bulkState.total = message.total;
        render();
        return;
      }
      if (message.type === 'DONE') {
        finish(message);
      }
    });

    // Fires before any DONE message when the extension id is wrong/not installed
    // (chrome.runtime.lastError set almost immediately) or the connection drops mid-run.
    port.onDisconnect.addListener(function () {
      finish({ ok: false, error: 'Install or open the Sales Manager extension in this browser to enrich leads.' });
    });

    try {
      port.postMessage({ type: 'ENRICH_LEADS', leads: targets });
    } catch (err) {
      finish({ ok: false, error: 'Install or open the Sales Manager extension in this browser to enrich leads.' });
    }
  }

  document.getElementById('filter-is-it').addEventListener('change', function (e) {
    state.filterIsIt = e.target.value;
    render();
  });
  document.getElementById('filter-source').addEventListener('change', function (e) {
    state.filterSource = e.target.value;
    render();
  });
  document.getElementById('filter-status').addEventListener('change', function (e) {
    state.filterStatus = e.target.value;
    render();
  });
  document.getElementById('filter-detail').addEventListener('change', function (e) {
    state.filterDetail = e.target.value;
    render();
  });
  document.getElementById('refresh-btn').addEventListener('click', loadLeads);
  document.getElementById('bulk-enrich-btn').addEventListener('click', startBulkEnrich);

  var extensionIdInput = document.getElementById('extension-id');
  extensionIdInput.value = localStorage.getItem(EXTENSION_ID_STORAGE_KEY) || '';
  extensionIdInput.addEventListener('input', function (e) {
    localStorage.setItem(EXTENSION_ID_STORAGE_KEY, e.target.value.trim());
  });
  document.getElementById('signout-btn').addEventListener('click', function () {
    var token = getCookie(COOKIE_NAME);
    var done = function () { clearCookieAndGoToLogin(); };
    if (token) {
      fetch('/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).then(done, done);
    } else {
      done();
    }
  });

  document.getElementById('backdrop').addEventListener('click', closeSidebar);
  document.getElementById('sidebar-close').addEventListener('click', closeSidebar);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSidebar();
  });

  renderHeader();
  loadLeads();
})();
</script>
</body>
</html>`;
}
