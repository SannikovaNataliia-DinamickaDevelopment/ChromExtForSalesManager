// Additive, self-contained sibling of dashboard-page.ts (same pattern — see that file's
// docstring): the one page that shows soft-deleted leads (GET /leads/deleted) and lets a user
// restore or permanently delete them. Deliberately not sharing a template with the main
// dashboard — no filters, sidebar, or bulk actions here, just a small table.
import { LEAD_RETENTION_DAYS } from '../leads/lead-retention';

export function renderDeletedLeadsPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deleted Leads</title>
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
  .page { max-width: 1100px; margin: 0 auto; padding: 24px 28px 60px; }
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
  .back-link {
    color: var(--text-secondary);
    font-size: 12px;
    text-decoration: none;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 12px;
  }
  .back-link:hover { border-color: var(--pink); color: var(--pink); }
  .hint-bar {
    color: var(--text-secondary);
    font-size: 12px;
    margin-bottom: 16px;
  }
  .table-wrap {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: auto;
  }
  table { border-collapse: collapse; width: 100%; min-width: 760px; }
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
    white-space: nowrap;
    border-bottom: 1px solid var(--border);
  }
  tbody td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
    color: var(--text-secondary);
  }
  tbody tr:last-child td { border-bottom: none; }
  td.title-cell { color: var(--text); font-weight: 500; }
  .badge {
    display: inline-block;
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    background: rgba(167, 139, 196, 0.16);
    color: var(--accent);
    text-transform: uppercase;
  }
  .days-left {
    font-weight: 600;
  }
  .days-left.soon { color: var(--error); }
  .actions { display: flex; gap: 8px; white-space: nowrap; }
  .actions button {
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    border-radius: 8px;
    padding: 6px 12px;
    cursor: pointer;
  }
  .restore-btn {
    background: var(--pink);
    color: #1A1420;
    border: none;
  }
  .restore-btn:hover { opacity: 0.9; }
  .purge-btn {
    background: transparent;
    color: var(--error);
    border: 1px solid var(--error);
  }
  .purge-btn:hover { background: var(--error-bg); }
  .actions button:disabled { cursor: not-allowed; opacity: 0.6; }
  .empty-state, .loading-state {
    padding: 40px;
    text-align: center;
    color: var(--text-secondary);
  }
  .row-error {
    font-size: 11px;
    color: var(--error);
    margin-top: 4px;
  }
</style>
</head>
<body>
<div class="page">
  <div class="topbar">
    <h1>Deleted Leads</h1>
    <a class="back-link" href="/dashboard">Back to dashboard</a>
  </div>
  <div class="hint-bar">Leads deleted more than ${LEAD_RETENTION_DAYS} days ago are purged automatically. Restore brings a lead back to the main dashboard; deleting permanently cannot be undone.</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>Source</th>
          <th>Company</th>
          <th>Deleted</th>
          <th>Days left</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="table-body">
        <tr><td class="loading-state" colspan="6">Loading deleted leads…</td></tr>
      </tbody>
    </table>
  </div>
</div>
<script>
(function () {
  var COOKIE_NAME = 'sm_dashboard_session';
  var LEAD_RETENTION_DAYS = ${LEAD_RETENTION_DAYS};
  var DAY_MS = 24 * 60 * 60 * 1000;

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

  function apiFetch(path, options) {
    var token = getCookie(COOKIE_NAME);
    if (!token) {
      clearCookieAndGoToLogin();
      return Promise.reject(new Error('Not signed in.'));
    }
    var opts = options || {};
    opts.headers = opts.headers || {};
    opts.headers['Authorization'] = 'Bearer ' + token;
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) {
        clearCookieAndGoToLogin();
        throw new Error('Session expired.');
      }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          throw new Error((data && data.error && data.error.message) || ('Request failed (' + res.status + ')'));
        }
        return data;
      });
    });
  }

  function formatKyiv(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '';
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    var get = function (type) {
      for (var i = 0; i < parts.length; i++) if (parts[i].type === type) return parts[i].value;
      return '';
    };
    return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute');
  }

  // deleted_at is stored/transmitted as UTC (like every other timestamp in this system) and
  // Date.now() is likewise UTC-based epoch ms — this is pure epoch-ms arithmetic with no
  // calendar/timezone conversion involved, so it can't drift from the backend's own UTC
  // "deleted_at < now() - LEAD_RETENTION_DAYS" purge comparison regardless of the viewer's
  // local timezone. Kyiv only ever enters the picture for *display* (formatKyiv above).
  function daysLeft(deletedAtIso) {
    var deletedAt = new Date(deletedAtIso).getTime();
    var purgeAt = deletedAt + LEAD_RETENTION_DAYS * DAY_MS;
    return Math.max(0, Math.ceil((purgeAt - Date.now()) / DAY_MS));
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

  function buildRow(lead) {
    var tr = document.createElement('tr');
    tr.appendChild(el('td', { className: 'title-cell', text: lead.job_title || '(untitled)' }));

    var sourceTd = document.createElement('td');
    if (lead.source_site) {
      sourceTd.appendChild(el('span', { className: 'badge', text: lead.source_site }));
    } else {
      sourceTd.textContent = '\\u2014';
    }
    tr.appendChild(sourceTd);

    tr.appendChild(el('td', { text: lead.company || '\\u2014' }));
    tr.appendChild(el('td', { text: formatKyiv(lead.deleted_at) || '\\u2014' }));

    var left = daysLeft(lead.deleted_at);
    tr.appendChild(el('td', {}, [
      el('span', { className: 'days-left' + (left <= 3 ? ' soon' : ''), text: String(left) }),
    ]));

    var actionsTd = document.createElement('td');
    var actionsWrap = el('div', { className: 'actions' });
    var errorEl = el('div', { className: 'row-error' });

    var restoreBtn = el('button', { className: 'restore-btn', type: 'button', text: 'Restore' });
    restoreBtn.addEventListener('click', function () {
      restoreBtn.disabled = true;
      purgeBtn.disabled = true;
      errorEl.textContent = '';
      apiFetch('/leads/' + lead.id + '/restore', { method: 'PATCH' })
        .then(loadLeads)
        .catch(function (err) {
          restoreBtn.disabled = false;
          purgeBtn.disabled = false;
          errorEl.textContent = err.message;
        });
    });

    var purgeBtn = el('button', { className: 'purge-btn', type: 'button', text: 'Delete permanently' });
    purgeBtn.addEventListener('click', function () {
      var confirmed = window.confirm('Permanently delete "' + (lead.job_title || '(untitled)') + '"? This cannot be undone.');
      if (!confirmed) return;
      restoreBtn.disabled = true;
      purgeBtn.disabled = true;
      errorEl.textContent = '';
      apiFetch('/leads/' + lead.id, { method: 'DELETE' })
        .then(loadLeads)
        .catch(function (err) {
          restoreBtn.disabled = false;
          purgeBtn.disabled = false;
          errorEl.textContent = err.message;
        });
    });

    actionsWrap.appendChild(restoreBtn);
    actionsWrap.appendChild(purgeBtn);
    actionsTd.appendChild(actionsWrap);
    actionsTd.appendChild(errorEl);
    tr.appendChild(actionsTd);

    return tr;
  }

  function render(leads) {
    var body = document.getElementById('table-body');
    body.innerHTML = '';
    if (leads.length === 0) {
      body.appendChild(el('tr', {}, [el('td', { colspan: '6', className: 'empty-state', text: 'No deleted leads.' })]));
      return;
    }
    leads.forEach(function (lead) { body.appendChild(buildRow(lead)); });
  }

  function loadLeads() {
    return apiFetch('/leads/deleted').then(render).catch(function (err) {
      var body = document.getElementById('table-body');
      body.innerHTML = '';
      body.appendChild(el('tr', {}, [el('td', { colspan: '6', className: 'empty-state', text: 'Failed to load: ' + err.message })]));
    });
  }

  loadLeads();
})();
</script>
</body>
</html>`;
}
