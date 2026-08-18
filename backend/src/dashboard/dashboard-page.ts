// Additive, self-contained dashboard feature (see module docstring in dashboard.module.ts).
// Everything — markup, dark theme, and the client-side table logic — lives in this one
// template function so the whole feature is just this folder + a couple of small, clearly
// marked hooks in the auth module.
import { LEAD_RETENTION_DAYS } from '../leads/lead-retention';

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
<script>
// Runs synchronously before first paint (plain web page, so localStorage — not
// chrome.storage, which isn't available here — see the theme-toggle wiring at the bottom of
// this page for the counterpart that writes this key). Sets the data-theme attribute the
// :root[data-theme='light'] CSS below keys off of, before any CSS has had a chance to paint
// the (dark) default — this is what avoids a flash of the wrong theme on reload. No stored
// value means first-time visitor: falls through to the unqualified :root block, which is
// dark, matching this dashboard's default.
(function () {
  try {
    var stored = localStorage.getItem('sm_dashboard_theme');
    if (stored === 'light') document.documentElement.setAttribute('data-theme', 'light');
  } catch (e) {}
})();
</script>
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
    /* Readable text color for anything using --error as a background (.delete-btn) — needs
       its own per-theme value because, unlike --pink, --error isn't roughly the same
       lightness in both themes (bright coral here, a darker saturated red in light mode
       below), so a single hardcoded text color can't stay legible against both. */
    --on-error: #1A1420;
    /* Readable text/icon color for anything using --pink (a constant across themes) as a
       background — the theme toggle's thumb, and the same role the side panel's --on-accent
       plays for its own pink-background buttons/badges. Constant for the same reason --pink
       itself is constant. */
    --on-accent: #1A1420;
    /* Accent-tinted backgrounds (table row hover, source badge, sidebar enrich block) were
       previously hardcoded rgba() literals baked from this theme's --accent/--accent-2 RGB —
       harmless while only dark mode existed, but wrong once --accent changes value in light
       mode below. Tokenized so both themes stay correct. */
    --accent-tint-weak: rgba(167, 139, 196, 0.1);
    --accent-tint: rgba(167, 139, 196, 0.16);
    --accent-2-tint: rgba(139, 123, 184, 0.1);
    /* Same fix, for the neutral (not-IT badge) tint — was hardcoded from --text-secondary's
       dark-mode RGB. Same name/values as the side panel's --chip-bg-neutral
       (extension/entrypoints/sidepanel/style.css) — same visual role, same token. */
    --chip-bg-neutral: rgba(217, 214, 222, 0.12);
  }

  /* Light theme — values pulled verbatim from the side panel's :root[data-theme='light']
     block (extension/entrypoints/sidepanel/style.css), which was itself derived from this
     dashboard's original dark-only palette above. Copied back here rather than re-derived so
     the two surfaces show numerically identical colors, not just visually similar ones.
     --pink stays identical in both themes (only ever a filled-button/badge background, never
     text-on-background, so no contrast-driven light variant is needed) — same reasoning as
     the side panel. */
  :root[data-theme='light'] {
    --bg: #FAF8FC;
    --panel: #FFFFFF;
    --panel-alt: #F1EAF6;
    --accent: #6B4A8C;
    --accent-2: #5A3F78;
    --pink: #C97FB0;
    --text: #241B2D;
    --text-secondary: #5B4E68;
    --border: rgba(107, 74, 140, 0.2);
    --error: #C42B3F;
    --error-bg: rgba(196, 43, 63, 0.12);
    --on-error: #FFFFFF;
    --on-accent: #1A1420;
    --accent-tint-weak: rgba(107, 74, 140, 0.1);
    --accent-tint: rgba(107, 74, 140, 0.16);
    --accent-2-tint: rgba(90, 63, 120, 0.1);
    --chip-bg-neutral: rgba(91, 78, 104, 0.10);
  }

  * { box-sizing: border-box; }
  /* Page-level scroll fix: html/body are hard-capped to the viewport height and never
     scroll themselves. .page is a flex column of exactly that height — header/stats/toolbar
     size to their own content as normal flex items, and .table-wrap (flex: 1; min-height: 0)
     absorbs whatever's left over and scrolls internally (its own overflow: auto, unchanged).
     Replaces the old .table-wrap max-height: 76vh, which assumed one fixed viewport height
     instead of adapting to whatever's actually available below the header on a given screen. */
  html, body { height: 100%; overflow: hidden; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Poppins', system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }
  .page {
    max-width: 1800px;
    height: 100vh;
    margin: 0 auto;
    padding: 24px 28px;
    display: flex;
    flex-direction: column;
  }
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
  /* Same moon/sun pattern as the side panel (extension/entrypoints/sidepanel/style.css) —
     identical markup/classes/pixel values, just built via a raw HTML string here instead of
     JSX. Sits in the topbar's right-aligned cluster, after .ext-id-field's margin-left:auto. */
  .theme-toggle {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    color: var(--text-secondary);
  }
  .theme-toggle-track {
    width: 36px;
    height: 20px;
    border-radius: 999px;
    background: var(--panel-alt);
    border: 1px solid var(--border);
    display: inline-flex;
    align-items: center;
    padding: 2px;
    transition: background 0.2s ease;
  }
  .theme-toggle-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--pink);
    color: var(--on-accent);
    display: flex;
    align-items: center;
    justify-content: center;
    transform: translateX(0);
    transition: transform 0.2s ease;
  }
  .theme-toggle-track.light .theme-toggle-thumb { transform: translateX(16px); }
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
  .search-field input {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 10px;
    font-family: inherit;
    font-size: 13px;
    width: 220px;
  }
  .search-field input:focus { outline: 1px solid var(--accent); }
  .count {
    color: var(--text-secondary);
    font-size: 12px;
    margin-left: auto;
  }
  /* Published/Scraped date-range filters — Jira-style: collapsed "MM/DD/YYYY → MM/DD/YYYY"
     field with prev/next shift arrows, expanding into a popover (presets + two-month
     calendar) on click. See createDateRangeFilter() for the JS. */
  .daterange-wrap { display: flex; flex-direction: column; }
  .daterange-wrap label { color: var(--text-secondary); font-size: 12px; margin-bottom: 2px; }
  .daterange-field {
    display: inline-flex;
    align-items: center;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .daterange-field:focus-within { outline: 1px solid var(--accent); }
  .daterange-arrow {
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 6px 8px;
    font-size: 14px;
    line-height: 1;
    font-family: inherit;
  }
  .daterange-arrow:hover:not(:disabled) { color: var(--pink); }
  .daterange-arrow:disabled { opacity: 0.35; cursor: not-allowed; }
  .daterange-input {
    background: transparent;
    border: none;
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    padding: 6px 4px;
    width: 190px;
    cursor: pointer;
    text-align: center;
  }
  .daterange-input::placeholder { color: var(--text-secondary); }
  .daterange-input:focus { outline: none; }
  .daterange-popover {
    position: fixed;
    z-index: 60;
    display: flex;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
    padding: 12px;
    gap: 16px;
  }
  .daterange-popover[hidden] { display: none; }
  .daterange-presets {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 168px;
    border-right: 1px solid var(--border);
    padding-right: 12px;
  }
  .daterange-preset-btn {
    background: none;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 7px 10px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    font-family: inherit;
  }
  .daterange-preset-btn:hover { background: var(--accent-tint-weak); color: var(--pink); }
  .daterange-preset-btn.clear {
    color: var(--text-secondary);
    margin-top: 6px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .daterange-calendars { display: flex; gap: 16px; }
  .daterange-month { width: 220px; }
  .daterange-month-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--accent);
  }
  .daterange-month-nav {
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 14px;
    padding: 2px 6px;
    font-family: inherit;
  }
  .daterange-month-nav:hover { color: var(--pink); }
  .daterange-month-nav.spacer { visibility: hidden; pointer-events: none; }
  .daterange-weekdays, .daterange-days {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
  }
  .daterange-weekdays span {
    font-size: 10px;
    color: var(--text-secondary);
    text-align: center;
    text-transform: uppercase;
  }
  .daterange-day {
    background: none;
    border: none;
    color: var(--text);
    font-size: 12px;
    padding: 5px 0;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
  }
  .daterange-day:hover:not(:disabled) { background: var(--accent-tint-weak); }
  .daterange-day.outside { visibility: hidden; }
  .daterange-day.today { box-shadow: inset 0 0 0 1px var(--accent); }
  .daterange-day.in-range { background: var(--accent-tint); border-radius: 0; }
  .daterange-day.range-start { background: var(--pink); color: var(--on-accent); border-radius: 6px 0 0 6px; }
  .daterange-day.range-end { background: var(--pink); color: var(--on-accent); border-radius: 0 6px 6px 0; }
  .daterange-day.range-start.range-end { border-radius: 6px; }
  /* Export modal — same presentation pattern as the detail sidebar's own backdrop (dimmed
     overlay, fade transition, escape/backdrop-click to close) but centered rather than
     right-anchored, and on its own backdrop element rather than sharing #backdrop: the sidebar
     and this modal are unrelated features that could otherwise fight over one shared open/close
     state if they shared a DOM node. */
  .export-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(10, 6, 14, 0.6);
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.2s ease;
    z-index: 40;
  }
  .export-modal-backdrop.open { opacity: 1; visibility: visible; }
  .export-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    width: min(420px, 92vw);
    max-height: min(600px, 84vh);
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
    padding: 22px 24px 18px;
    opacity: 0;
    visibility: hidden;
    transform: translate(-50%, -50%) scale(0.98);
    transition: opacity 0.2s ease, transform 0.2s ease;
    z-index: 50;
  }
  .export-modal.open { opacity: 1; visibility: visible; transform: translate(-50%, -50%) scale(1); }
  .export-modal-title {
    color: var(--accent);
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 14px;
  }
  .export-modal-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .export-modal-section { margin-bottom: 14px; }
  .export-modal-section-label {
    font-size: 11px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.4px;
    margin-bottom: 6px;
  }
  .export-filter-summary {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .export-filter-summary li {
    font-size: 12px;
    color: var(--text);
    background: var(--panel-alt);
    border-radius: 6px;
    padding: 4px 8px;
  }
  .export-filter-summary li.empty {
    color: var(--text-secondary);
    background: none;
    padding: 0;
  }
  .export-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .export-panel-header-actions button {
    background: none;
    border: none;
    padding: 0 4px;
    color: var(--accent);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .export-panel-header-actions button:hover { color: var(--pink); }
  .export-panel-columns {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .export-panel-columns label {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }
  .export-modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .export-modal-cancel {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 7px 16px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }
  .export-modal-cancel:hover { color: var(--text); border-color: var(--accent); }
  .export-modal-submit {
    background: var(--pink);
    color: #1A1420;
    border: none;
    border-radius: 8px;
    padding: 7px 18px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .export-modal-submit:disabled, .export-modal-cancel:disabled { cursor: not-allowed; opacity: 0.6; }
  .export-status {
    color: var(--text-secondary);
    font-size: 12px;
  }
  .export-status.error { color: var(--error); }
  .stats-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 18px;
  }
  .stat-tile {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 16px;
    min-width: 96px;
  }
  .stat-value {
    font-size: 22px;
    font-weight: 700;
    color: var(--accent);
    line-height: 1.25;
  }
  .stat-label {
    font-size: 11px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.4px;
    margin-top: 2px;
  }
  .stat-group {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 16px;
  }
  .stat-group-label {
    font-size: 11px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.4px;
    margin-bottom: 8px;
  }
  .stat-group-body {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .stat-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 999px;
    background: var(--panel-alt);
    border: 1px solid var(--border);
    font-size: 12px;
    color: var(--text);
    text-transform: uppercase;
    letter-spacing: 0.2px;
  }
  .stat-chip-count {
    font-weight: 700;
    color: var(--pink);
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
  .bulk-bar .bulk-delete-btn { background: var(--error); color: var(--on-error); }
  .bulk-bar .bulk-status { color: var(--text-secondary); font-size: 12px; }
  /* Selection column: fixed width (uniform across every row regardless of that row's own
     content — buildCheckboxTd always renders exactly one <input>, nothing else, so this was
     already consistent before the sizing change below) and vertical-align: middle, overriding
     tbody td's own top-alignment default (set for reading wrapped multi-line text) so the
     checkbox sits centered in the row's actual height instead of pinned to the top — row height
     itself is still driven entirely by the tallest cell in that row (e.g. wrapped company/title
     text), so this only changes where within that height the checkbox sits, never the height
     itself. Click target is the whole cell (buildCheckboxTd/buildSelectAllTh's own click
     listener + toggleCheckboxCell), not just the input — width bumped slightly (34px →
     40px) to give the larger checkbox the same breathing room it had before. */
  td.checkbox-cell, th.checkbox-cell { width: 40px; text-align: center; padding-left: 14px; padding-right: 4px; vertical-align: middle; cursor: pointer; }
  td.checkbox-cell input, th.checkbox-cell input { width: 17px; height: 17px; cursor: pointer; vertical-align: middle; accent-color: var(--pink); }
  td.checkbox-cell input:disabled, th.checkbox-cell input:disabled { cursor: not-allowed; }
  /* Click-and-drag multi-select (checkbox column): toggled on <body> for the duration of a
     drag (startDragSelect/endDragSelect) — belt-and-braces alongside the mousedown handler's
     own preventDefault(), which already stops the drag from starting a native text selection
     at its source; this covers any edge case that slips past that (e.g. a very fast drag
     crossing into unrelated text before the first mousemove is processed). */
  body.drag-selecting, body.drag-selecting * { user-select: none; -webkit-user-select: none; }
  .table-wrap {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: auto;
    flex: 1;
    min-height: 0;
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
  tbody tr:hover { background: var(--accent-tint-weak); }
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
  .badge.not_it { background: var(--chip-bg-neutral); color: var(--text-secondary); }
  .badge.source { background: var(--accent-tint); color: var(--accent); text-transform: uppercase; }
  /* Warning icon (title-cell, table row) — "System couldn't process this lead" tooltip on
     hover, via the native title attribute (see buildRow/ERROR_TOOLTIP_TEXT). Small filled
     circle rather than a bare "!" glyph so it reads as a status indicator at a glance, same
     visual weight as .badge, not just loose text next to the title. */
  .error-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-left: 6px;
    border-radius: 50%;
    background: var(--error);
    color: var(--on-error);
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    cursor: help;
    vertical-align: middle;
  }
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
    background: var(--accent-2-tint);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  /* Sidebar's "click" half of the warning icon's hover/click contract — sits above the Enrich
     block (which stays visible/clickable here, per the manual-retry design) so the retry
     affordance is right below the explanation of why it's needed. */
  .error-banner {
    margin-bottom: 14px;
    padding: 10px 12px;
    background: var(--error-bg);
    border: 1px solid var(--error);
    border-radius: 8px;
    color: var(--error);
    font-size: 13px;
    line-height: 1.5;
  }
  .error-banner-reason {
    margin-top: 4px;
    font-size: 12px;
    opacity: 0.85;
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
  /* Plain layout wrapper only — no tinted/bordered card. Deliberately unlike .enrich-block:
     that box (padding + tint + border) reads as a highlighted, boxed "card" for a routine
     brand-colored action, and doubling that treatment with --error's more attention-grabbing
     red made Delete look like a heavy glowing warning box rather than a same-weight sibling
     action to Enrich. Lives in the Description heading row now (sidebar-desc-header below),
     not directly under the title — it shouldn't be the first/loudest thing in the panel.
     Outlined by default rather than solid-filled, so it doesn't compete with the actual lead
     content for attention; fills solid only on hover, still unambiguously a destructive
     action without demanding notice up front. */
  .delete-btn {
    background: transparent;
    color: var(--error);
    border: 1px solid var(--error);
    border-radius: 6px;
    padding: 3px 10px;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }
  .delete-btn:hover { background: var(--error); color: var(--on-error); }
  .delete-btn:disabled { cursor: not-allowed; opacity: 0.6; }
  .delete-status {
    margin-top: 6px;
    font-size: 12px;
    color: var(--error);
    line-height: 1.5;
  }
  .status-select {
    background: var(--panel-alt);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 6px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .status-select:focus { outline: 1px solid var(--accent); }
  .status-select.field-error { border-color: var(--error); outline: 1px solid var(--error); }
  .deleted-link {
    color: var(--text-secondary);
    font-size: 12px;
    text-decoration: none;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 12px;
  }
  .deleted-link:hover { border-color: var(--pink); color: var(--pink); }
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
  /* Delete lives here now — same row as the Description heading, right-aligned, after every
     metadata field and right before the description text — not the first thing under the
     title. Row-level margins moved here from .sidebar-desc-label since the label no longer
     owns its own spacing (the button needs to align on the same line). */
  .sidebar-desc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 24px;
    margin-bottom: 10px;
  }
  .sidebar-desc-label {
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
    <button type="button" class="theme-toggle" id="theme-toggle" aria-label="Switch to light mode" title="Switch to light mode">
      <span class="theme-toggle-track dark" id="theme-toggle-track">
        <span class="theme-toggle-thumb" id="theme-toggle-thumb">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z" /></svg>
        </span>
      </span>
    </button>
    <a class="deleted-link" href="/dashboard/deleted">Deleted leads</a>
    <button class="signout-btn" id="signout-btn" type="button">Sign out</button>
  </div>
  ${authErrorHtml}
  <div class="stats-strip" id="stats-strip">
    <div class="stat-tile">
      <div class="stat-value" id="stat-total">—</div>
      <div class="stat-label">Total leads</div>
    </div>
    <div class="stat-tile">
      <div class="stat-value" id="stat-new-today">—</div>
      <div class="stat-label">New today</div>
    </div>
    <div class="stat-group">
      <div class="stat-group-label">By source</div>
      <div class="stat-group-body" id="stat-by-source"></div>
    </div>
    <div class="stat-group">
      <div class="stat-group-label">By IT</div>
      <div class="stat-group-body" id="stat-by-is-it"></div>
    </div>
  </div>
  <div class="toolbar">
    <span class="search-field">
      <label for="search-input">Search</label>
      <input type="text" id="search-input" placeholder="Title or company…" autocomplete="off">
    </span>
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
        <option value="error">Error</option>
      </select>
    </span>
    <span>
      <label for="filter-contact">Contact</label>
      <select id="filter-contact">
        <option value="all">All</option>
        <option value="found">Has contact person</option>
        <option value="not_specified">Not specified</option>
        <option value="not_checked">Not detailed for contact person</option>
      </select>
    </span>
    <span>
      <label for="filter-company-linkedin">Company LinkedIn</label>
      <select id="filter-company-linkedin">
        <option value="all">All</option>
        <option value="found">Has company LinkedIn</option>
        <option value="not_specified">Not specified</option>
        <option value="not_checked">Not detailed</option>
      </select>
    </span>
    <span class="daterange-wrap">
      <label for="filter-published-range-input">Published Date</label>
      <span class="daterange-field" id="filter-published-range-field">
        <button type="button" class="daterange-arrow" id="filter-published-range-prev" aria-label="Shift range back" title="Shift range back" disabled>‹</button>
        <input type="text" id="filter-published-range-input" class="daterange-input" readonly placeholder="All dates" autocomplete="off">
        <button type="button" class="daterange-arrow" id="filter-published-range-next" aria-label="Shift range forward" title="Shift range forward" disabled>›</button>
      </span>
    </span>
    <span class="daterange-wrap">
      <label for="filter-scraped-range-input">Scraped Date</label>
      <span class="daterange-field" id="filter-scraped-range-field">
        <button type="button" class="daterange-arrow" id="filter-scraped-range-prev" aria-label="Shift range back" title="Shift range back" disabled>‹</button>
        <input type="text" id="filter-scraped-range-input" class="daterange-input" readonly placeholder="All dates" autocomplete="off">
        <button type="button" class="daterange-arrow" id="filter-scraped-range-next" aria-label="Shift range forward" title="Shift range forward" disabled>›</button>
      </span>
    </span>
    <button class="refresh" id="refresh-btn" type="button">Refresh</button>
    <button class="refresh" id="export-btn" type="button" aria-haspopup="dialog" aria-expanded="false" title="Export the leads currently visible under the active filters/search">Export</button>
    <span class="export-status" id="export-status"></span>
    <span class="count" id="count"></span>
  </div>
  <div class="bulk-bar" id="bulk-bar" hidden>
    <span class="bulk-count" id="bulk-count"></span>
    <button id="bulk-enrich-btn" type="button">Enrich selected</button>
    <button id="bulk-contact-btn" type="button">Backfill contact selected</button>
    <button id="bulk-company-linkedin-btn" type="button" title="Fetches each selected lead's company_website and scans it for LinkedIn links (capped at 50/run)">Backfill LinkedIn selected</button>
    <button id="bulk-delete-btn" class="bulk-delete-btn" type="button">Delete selected</button>
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
<div class="export-modal-backdrop" id="export-modal-backdrop"></div>
<div class="export-modal" id="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-modal-title" aria-hidden="true">
  <div class="export-modal-title" id="export-modal-title">Export leads</div>
  <div class="export-modal-body">
    <div class="export-modal-section">
      <div class="export-modal-section-label">Exporting</div>
      <ul class="export-filter-summary" id="export-filter-summary"></ul>
    </div>
    <div class="export-modal-section">
      <div class="export-panel-header">
        <span>Columns to export</span>
        <span class="export-panel-header-actions">
          <button type="button" id="export-select-all">All</button>
          <button type="button" id="export-select-none">None</button>
        </span>
      </div>
      <div class="export-panel-columns" id="export-panel-columns"></div>
    </div>
  </div>
  <div class="export-modal-footer">
    <button type="button" class="export-modal-cancel" id="export-modal-cancel">Cancel</button>
    <button type="button" class="export-modal-submit" id="export-columns-submit">Export</button>
  </div>
</div>
<script>
(function () {
  var COOKIE_NAME = 'sm_dashboard_session';
  var STATUS_LABELS = { new: 'новий', in_progress: 'опрацьовується', done: 'опрацьований' };
  var IS_IT_LABELS = { it: 'IT', not_it: 'not-IT', unprocessed: '' };
  var COLUMN_COUNT = 13; // 12 data columns + the leading checkbox column
  // Warning-icon tooltip (table row, hover) and the lead-in line of the sidebar's error banner
  // (row click) — same wording either way, the sidebar just adds the specific stored reason
  // underneath. See lead.enrichment_error's schema comment for how a lead gets into this state.
  var ERROR_TOOLTIP_TEXT = "System couldn't process this lead \\u2014 try manually, or delete it if no longer relevant.";
  // "Enrich" button (extension-side deepening triggered from this page — see background.ts's
  // ENRICH_LEAD handler). Each dev/browser loads the extension with its own id
  // (chrome://extensions), so this can't be hardcoded — the manager pastes it in once and
  // it's remembered in this browser.
  var EXTENSION_ID_STORAGE_KEY = 'sm_extension_id';
  // Plain web page, not an extension context — chrome.storage isn't available here, so
  // localStorage (matches the pattern EXTENSION_ID_STORAGE_KEY already uses above). Read
  // synchronously by the inline <head> script (before first paint, to avoid a theme flash on
  // reload) and written here on toggle click; independent of the side panel's own 'sm_theme'
  // chrome.storage.local key — the two surfaces don't sync.
  var THEME_STORAGE_KEY = 'sm_dashboard_theme';
  // Interpolated once, server-side, at render time — same pattern deleted-leads-page.ts uses
  // for its own copy of this constant. Delete confirm messages below reference this as a
  // plain client-side variable rather than re-interpolating ${LEAD_RETENTION_DAYS} inline at
  // every call site.
  var LEAD_RETENTION_DAYS = ${LEAD_RETENTION_DAYS};
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
    selected: {}, // leadId -> true, any lead regardless of detail status
    inFlight: false,
    // 'enrich' | 'delete' | null — which of the two bulk actions is currently running, so the
    // shared inFlight flag (constraint: only one bulk batch at a time) can still show the
    // right progress text. Mutually exclusive by construction: both buttons check
    // bulkState.inFlight before starting, so a second bulk action can't start from this tab
    // while one is already running, regardless of mode.
    mode: null,
    completed: 0,
    total: 0,
    status: '',
  };

  // Single source of truth for every column this page knows about (2026-08-18: replaced two
  // separately-maintained lists — COLUMNS and EXPORT_COLUMNS used to be independent arrays, kept
  // in sync by hand, and predictably drifted: company_linkedin was added to the table's COLUMNS
  // but never copied into EXPORT_COLUMNS, so it silently never showed up in the export column
  // picker). COLUMNS (main table) and EXPORT_COLUMNS (export panel's checkbox list) are now both
  // *derived* from this one array below — adding a column here with inTable:true makes it appear
  // in both places automatically; there is no second list left to forget.
  //
  // Order here IS the export column order (and, for entries with inTable:true, the table's own
  // column order too — COLUMNS is a filtered subsequence of this array, never reordered). export
  // includes several fields the table never shows at all (description, salary, tech_stack,
  // apply_url, ats, external_job_id, created_at) — export's whole point is "every field", not
  // just what's in the table view, so inTable:false for those is intentional, not an oversight.
  //
  // label is used in both the table header and the export checkbox unless exportLabel overrides
  // it — scraped_at is the one case that needs to (a compact "Scraped" table header vs. a more
  // descriptive "Scraped (Kyiv)" export checkbox label; the table header has much less room).
  //
  // Still mirrors backend's EXPORT_COLUMNS (leads/export-columns.ts) key list — the server
  // remains the single source of truth for what each key actually maps to and how it's
  // formatted (POST /leads/export re-validates every key against its own copy via IsIn); this
  // array only drives what renders in the table/checkbox UI here.
  var ALL_COLUMNS = [
    { key: 'published_at', label: 'Published', inTable: true },
    { key: 'source_site', label: 'Source', inTable: true },
    { key: 'job_title', label: 'Title', inTable: true },
    { key: 'source_url', label: 'Job link', inTable: true },
    { key: 'is_it', label: 'IT?', inTable: true },
    { key: 'company', label: 'Company', inTable: true },
    { key: 'company_website', label: 'Website', inTable: true },
    { key: 'company_linkedin', label: 'Company LinkedIn', inTable: true },
    { key: 'location', label: 'Location', inTable: true },
    { key: 'salary', label: 'Salary', inTable: false },
    { key: 'tech_stack', label: 'Tech stack', inTable: false },
    { key: 'description', label: 'Description', inTable: false },
    { key: 'apply_url', label: 'Apply link', inTable: false },
    { key: 'ats', label: 'ATS', inTable: false },
    { key: 'external_job_id', label: 'External job ID', inTable: false },
    { key: 'status', label: 'Status', inTable: true },
    { key: 'owner', label: 'Owner', inTable: true },
    { key: 'scraped_at', label: 'Scraped', exportLabel: 'Scraped (Kyiv)', inTable: true },
    { key: 'created_at', label: 'Created (Kyiv)', inTable: false },
  ];

  var COLUMNS = ALL_COLUMNS.filter(function (c) { return c.inTable; });
  var EXPORT_COLUMNS = ALL_COLUMNS.map(function (c) {
    return { key: c.key, label: c.exportLabel || c.label };
  });

  var state = {
    leads: [],
    sortKey: 'published_at',
    sortDir: 'desc',
    filterIsIt: 'all',
    filterStatus: 'all',
    filterSource: 'all',
    filterDetail: 'all',
    filterContact: 'all',
    filterCompanyLinkedin: 'all',
    // null = "All dates"; otherwise { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } (Kyiv calendar
    // days, inclusive both ends) — see createDateRangeFilter().
    filterPublishedRange: null,
    filterScrapedRange: null,
    search: '',
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

  // Shared helper for the row-level actions below (status change, soft delete) — loadLeads()
  // keeps its own inline fetch chain unchanged (different error-rendering needs: a full-table
  // "failed to load" state vs. a per-row failure), this is only for the smaller one-off writes.
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

  // Dashboard "Export" — a separate fetch wrapper rather than apiFetch above: apiFetch always
  // parses the response as JSON, but a successful export response is an .xlsx binary blob, not
  // JSON (only the *error* path, if any, is JSON, from the same AppError shape every other
  // endpoint uses).
  var exportInFlight = false;

  function setExportStatus(text, isError) {
    var el = document.getElementById('export-status');
    el.textContent = text || '';
    el.className = isError ? 'export-status error' : 'export-status';
  }

  function setExportControlsDisabled(disabled) {
    document.getElementById('export-btn').disabled = disabled;
    document.getElementById('export-columns-submit').disabled = disabled;
    document.getElementById('export-modal-cancel').disabled = disabled;
  }

  // columns: omitted/null = every field; an array of EXPORT_COLUMNS keys = the panel's
  // column-limited export. leadIds is always getFiltered() at click time — "the leads currently
  // visible under the active filters/search", same set the table itself is showing, not the
  // bulk-action row-selection checkboxes (a separate, unrelated selection mechanism — see
  // bulkState above).
  function runExport(columns) {
    if (exportInFlight) return;
    var leads = getFiltered();
    if (leads.length === 0) {
      setExportStatus('No leads match the current filters — nothing to export.', true);
      return;
    }
    var token = getCookie(COOKIE_NAME);
    if (!token) { clearCookieAndGoToLogin(); return; }

    exportInFlight = true;
    setExportControlsDisabled(true);
    setExportStatus('Exporting ' + leads.length + ' lead' + (leads.length === 1 ? '' : 's') + '…', false);

    var payload = { leadIds: leads.map(function (l) { return l.id; }) };
    if (columns) payload.columns = columns;

    fetch('/leads/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        if (res.status === 401) { clearCookieAndGoToLogin(); throw new Error('Session expired.'); }
        if (!res.ok) {
          return res.json().catch(function () { return null; }).then(function (data) {
            throw new Error((data && data.error && data.error.message) || ('Export failed (' + res.status + ')'));
          });
        }
        return res.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'leads-export-' + new Date().toISOString().slice(0, 10) + '.xlsx';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setExportStatus('Exported ' + leads.length + ' lead' + (leads.length === 1 ? '' : 's') + '.', false);
      })
      .catch(function (err) {
        setExportStatus('Export failed: ' + err.message, true);
      })
      .finally(function () {
        exportInFlight = false;
        setExportControlsDisabled(false);
      });
  }

  function buildExportPanelColumns() {
    var container = document.getElementById('export-panel-columns');
    container.innerHTML = '';
    EXPORT_COLUMNS.forEach(function (col) {
      var label = document.createElement('label');
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.value = col.key;
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(col.label));
      container.appendChild(label);
    });
  }

  // Demo feedback: clicking "Export" should show the user exactly what they're about to get —
  // filter/search scope and column selection — before anything downloads, not fire immediately.
  // Rebuilt fresh every time the panel opens (rather than kept live via the filter/search change
  // listeners below) since it's cheap to build and the panel is hidden most of the time anyway;
  // no risk of it drifting stale while closed.
  var IS_IT_FILTER_SUMMARY_LABELS = { it: 'IT only', not_it: 'not-IT only', unprocessed: 'Unprocessed only' };
  var DETAIL_FILTER_SUMMARY_LABELS = { not_detailed: 'Not detailed', detailed: 'Detailed', error: 'Error' };
  var CONTACT_FILTER_SUMMARY_LABELS = { found: 'Has contact person', not_specified: 'Not specified', not_checked: 'Not detailed for contact person' };
  var COMPANY_LINKEDIN_FILTER_SUMMARY_LABELS = { found: 'Has company LinkedIn', not_specified: 'Not specified', not_checked: 'Not detailed' };

  function buildExportFilterSummaryLines() {
    var lines = [];
    if (state.filterIsIt !== 'all') lines.push('IT filter: ' + (IS_IT_FILTER_SUMMARY_LABELS[state.filterIsIt] || state.filterIsIt));
    if (state.filterStatus !== 'all') lines.push('Status: ' + (STATUS_LABELS[state.filterStatus] || state.filterStatus));
    if (state.filterSource !== 'all') lines.push('Source: ' + state.filterSource);
    if (state.filterDetail !== 'all') lines.push('Detail: ' + (DETAIL_FILTER_SUMMARY_LABELS[state.filterDetail] || state.filterDetail));
    if (state.filterContact !== 'all') lines.push('Contact: ' + (CONTACT_FILTER_SUMMARY_LABELS[state.filterContact] || state.filterContact));
    if (state.filterCompanyLinkedin !== 'all') lines.push('Company LinkedIn: ' + (COMPANY_LINKEDIN_FILTER_SUMMARY_LABELS[state.filterCompanyLinkedin] || state.filterCompanyLinkedin));
    if (state.filterPublishedRange) lines.push('Published date: ' + formatUsDate(state.filterPublishedRange.start) + ' \\u2013 ' + formatUsDate(state.filterPublishedRange.end));
    if (state.filterScrapedRange) lines.push('Scraped date: ' + formatUsDate(state.filterScrapedRange.start) + ' \\u2013 ' + formatUsDate(state.filterScrapedRange.end));
    if (state.search) lines.push('Search: "' + state.search + '"');
    return lines;
  }

  function renderExportFilterSummary() {
    var list = document.getElementById('export-filter-summary');
    list.innerHTML = '';
    var lines = buildExportFilterSummaryLines();
    if (lines.length === 0) {
      list.appendChild(el('li', { className: 'empty', text: 'No filters applied — exporting all leads.' }));
      return;
    }
    lines.forEach(function (line) {
      list.appendChild(el('li', { text: line }));
    });
  }

  // Presentation: centered modal + full-page dimmed backdrop (same visual language as Google
  // Docs' Share dialog, per demo feedback — the earlier corner-anchored popover was replaced
  // wholesale, but everything it fed into (runExport, the column checkboxes, the filter summary
  // builder above) is untouched). Own backdrop element rather than the sidebar's shared
  // #backdrop — see the CSS comment on .export-modal-backdrop for why.
  function setExportModalOpen(open) {
    document.getElementById('export-modal').classList.toggle('open', open);
    document.getElementById('export-modal-backdrop').classList.toggle('open', open);
    document.getElementById('export-modal').setAttribute('aria-hidden', open ? 'false' : 'true');
    document.getElementById('export-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderExportFilterSummary();
  }

  function updateLeadStatus(id, status) {
    return apiFetch('/leads/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: status }),
    });
  }

  function softDeleteLead(id) {
    return apiFetch('/leads/' + id + '/delete', { method: 'PATCH' });
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

  // ---- Published/Scraped date-range filters (Jira-style range picker) ----
  // Two independent instances (published_at, scraped_at) share this one builder/factory.
  // Collapsed: prev/next arrows either side of a "MM/DD/YYYY → MM/DD/YYYY" input; clicking the
  // input opens a popover with a preset list (left) and two browsable month calendars (right)
  // for a manual custom pick. No existing date-range-picker dependency in this project to reuse
  // (backend/package.json has none, and this page has no build step to import one through even
  // if it did — everything here is hand-rolled vanilla JS, same as the rest of this file), so
  // this is built from scratch, styled with the same CSS custom properties as everything else.
  //
  // Kyiv-day convention (getKyivTodayYmd below) — all preset boundaries (Today/Current week/
  // etc.) and the getFiltered() comparison itself are computed against the Kyiv calendar day,
  // same as every other date already shown on this page (formatKyiv), not the server's or
  // browser's local timezone.
  function getKyivTodayYmd() {
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    var get = function (type) { for (var i = 0; i < parts.length; i++) if (parts[i].type === type) return parts[i].value; return ''; };
    return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')) };
  }

  // Plain calendar-date arithmetic from here down — once "today" is known as a Kyiv Y-M-D triple
  // (above, the only place this ever touches the real clock/timezone), everything else is
  // timezone-naive integer math on a UTC-midnight Date used purely as a date-math substrate —
  // same convention multipage.ts's parseDateOnlyToUtcMidnight already uses for the same reason.
  function ymdToDate(y, m, d) { return new Date(Date.UTC(y, m - 1, d)); }
  function ymdStrToDate(s) {
    var p = s.split('-').map(Number);
    return ymdToDate(p[0], p[1], p[2]);
  }
  function dateToYmdStr(date) {
    return date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + String(date.getUTCDate()).padStart(2, '0');
  }
  function formatUsDate(ymdStr) {
    var p = ymdStr.split('-');
    return p[1] + '/' + p[2] + '/' + p[0];
  }
  function addDays(date, n) { return new Date(date.getTime() + n * 86400000); }
  function startOfWeek(date) { // Monday-start week, matching this project's other Ukraine-facing UI
    var dow = date.getUTCDay(); // 0=Sun..6=Sat
    return addDays(date, dow === 0 ? -6 : 1 - dow);
  }
  function startOfMonth(date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)); }
  function endOfMonth(date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)); }
  function startOfQuarter(date) { var q = Math.floor(date.getUTCMonth() / 3); return new Date(Date.UTC(date.getUTCFullYear(), q * 3, 1)); }
  function endOfQuarter(date) { var q = Math.floor(date.getUTCMonth() / 3); return new Date(Date.UTC(date.getUTCFullYear(), q * 3 + 3, 0)); }
  function addMonths(date, n) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1)); }

  // "Previous 3 months"/"Previous quarter" are the 3 calendar months / quarter immediately
  // preceding the current one (e.g. today in August → Previous 3 months = May 1–Jul 31), not a
  // rolling "last 90 days" — matches how "Previous month"/"Previous week" are calendar-aligned
  // too, and Jira's own preset semantics for the same labels.
  function buildDateRangePresets(today) {
    var weekStart = startOfWeek(today);
    var monthStart = startOfMonth(today);
    var quarterStart = startOfQuarter(today);
    var yearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    var prevWeekStart = addDays(weekStart, -7);
    var prevMonthStart = addMonths(monthStart, -1);
    var prev3MonthsStart = addMonths(monthStart, -3);
    var prevQuarterStart = addMonths(quarterStart, -3);
    return [
      { label: 'Today', start: today, end: today },
      { label: 'Current week', start: weekStart, end: addDays(weekStart, 6) },
      { label: 'Current month', start: monthStart, end: endOfMonth(today) },
      { label: 'Current quarter', start: quarterStart, end: endOfQuarter(today) },
      { label: 'Current year', start: yearStart, end: new Date(Date.UTC(today.getUTCFullYear(), 11, 31)) },
      { label: 'Previous week', start: prevWeekStart, end: addDays(prevWeekStart, 6) },
      { label: 'Previous month', start: prevMonthStart, end: endOfMonth(prevMonthStart) },
      { label: 'Previous 3 months', start: prev3MonthsStart, end: endOfMonth(prevMonthStart) },
      { label: 'Previous quarter', start: prevQuarterStart, end: endOfMonth(addMonths(quarterStart, -1)) },
    ];
  }

  var DATERANGE_WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  // Shared by the initial calendar build and the hover-preview re-highlight below — one place
  // deciding a day cell's classes from a (rangeStart, rangeEnd) pair, so the two can never
  // render a day differently for the same inputs.
  function computeDayClasses(cellDate, todayYmd, rangeStart, rangeEnd) {
    var classes = ['daterange-day'];
    if (cellDate.getUTCFullYear() === todayYmd.y && cellDate.getUTCMonth() + 1 === todayYmd.m && cellDate.getUTCDate() === todayYmd.d) classes.push('today');
    var isStart = !!rangeStart && cellDate.getTime() === rangeStart.getTime();
    // A lone pending pick (start clicked, end not yet — no hover in progress either) counts as
    // both start AND end for styling purposes — it's a single highlighted day, not a zero-width
    // range with an undefined far edge.
    var isEnd = (!!rangeEnd && cellDate.getTime() === rangeEnd.getTime()) || (!rangeEnd && isStart);
    if (rangeStart && rangeEnd && cellDate.getTime() > rangeStart.getTime() && cellDate.getTime() < rangeEnd.getTime()) classes.push('in-range');
    if (isStart) classes.push('range-start');
    if (isEnd) classes.push('range-end');
    return classes;
  }

  // opts: { stateKey, fieldId, inputId, prevBtnId, nextBtnId }
  function createDateRangeFilter(opts) {
    var popoverEl = null;
    var pendingStart = null; // Date | null — set while mid-manual-pick (first day clicked, waiting for the second)
    var hoverDate = null; // Date | null — cursor's current day while mid-pick, drives the live range preview below
    var viewMonth = null; // Date (day=1) — the LEFT calendar's currently-browsed month; right calendar is always viewMonth+1
    // Every rendered (non-blank) day button across both grids, refreshed on each renderCalendars()
    // full rebuild — lets the hover-preview re-highlight existing buttons in place (just a
    // className write) instead of re-running renderCalendars() on every mouse movement, which
    // would rebuild ~84 DOM elements per hovered cell — cheap in absolute terms at this scale, but
    // pointless churn (flicker, lost hover state) for something a plain class swap already covers.
    var renderedDayButtons = [];

    function currentRange() {
      var r = state[opts.stateKey];
      return r ? { start: ymdStrToDate(r.start), end: ymdStrToDate(r.end) } : null;
    }

    function updateFieldUI() {
      var input = document.getElementById(opts.inputId);
      var r = state[opts.stateKey];
      input.value = r ? formatUsDate(r.start) + '  \\u2192  ' + formatUsDate(r.end) : '';
      document.getElementById(opts.prevBtnId).disabled = !r;
      document.getElementById(opts.nextBtnId).disabled = !r;
    }

    function applyRange(start, end) {
      if (end.getTime() < start.getTime()) { var t = start; start = end; end = t; }
      state[opts.stateKey] = { start: dateToYmdStr(start), end: dateToYmdStr(end) };
      pendingStart = null;
      hoverDate = null;
      closePopover();
      updateFieldUI();
      render();
    }

    function clearRange() {
      state[opts.stateKey] = null;
      pendingStart = null;
      hoverDate = null;
      closePopover();
      updateFieldUI();
      render();
    }

    // Shifts the whole applied range backward/forward by its own inclusive day-span (e.g. a
    // 31-day range shifts by 31 days) — a plain day-count shift works uniformly for both preset-
    // generated ranges and an arbitrary custom pick, which a calendar-aware "next month" style
    // shift wouldn't (there's no single well-defined "next" for an arbitrary custom range).
    // Disabled via the field's own prevBtn/nextBtn 'disabled' attribute when nothing is applied
    // yet (see updateFieldUI) — nothing to shift from in that state, so this never needs a
    // fallback for the "no range selected" case.
    function shiftRange(dir) {
      var r = currentRange();
      if (!r) return;
      var spanDays = Math.round((r.end.getTime() - r.start.getTime()) / 86400000) + 1;
      var deltaMs = dir * spanDays * 86400000;
      applyRange(new Date(r.start.getTime() + deltaMs), new Date(r.end.getTime() + deltaMs));
    }

    function onDayClick(date) {
      if (!pendingStart) {
        pendingStart = date;
        hoverDate = null;
        renderCalendars();
        return;
      }
      applyRange(pendingStart, date);
    }

    // Live range preview while mid-pick (Jira's own worklog date-range picker does the same):
    // fills in the background across every day between the clicked start and wherever the
    // cursor currently is, updating continuously as it moves — never committed, purely visual,
    // the actual range is still only set on the second click (onDayClick -> applyRange above).
    // A no-op once a range is already fully committed (pendingStart is null then) or before any
    // start has been picked yet — there's nothing to preview against in either case.
    function onDayHover(date) {
      if (!pendingStart) return;
      hoverDate = date;
      applyHoverHighlight();
    }

    // Cheap re-highlight of the already-rendered day buttons (a className write per button, no
    // DOM rebuild) — see renderedDayButtons' own comment for why this doesn't just call
    // renderCalendars() on every hover.
    function applyHoverHighlight() {
      if (!pendingStart) return;
      var lo = pendingStart;
      var hi = hoverDate || pendingStart; // no hover yet (or cursor left the grid) -> single day, same as a fresh pending pick
      if (hi.getTime() < lo.getTime()) { var t = lo; lo = hi; hi = t; }
      var todayYmd = getKyivTodayYmd();
      renderedDayButtons.forEach(function (entry) {
        entry.el.className = computeDayClasses(entry.date, todayYmd, lo, hi).join(' ');
      });
    }

    function buildMonthGrid(monthDate, showPrevNav, showNextNav, rangeStart, rangeEnd) {
      var wrap = document.createElement('div');
      wrap.className = 'daterange-month';

      var header = document.createElement('div');
      header.className = 'daterange-month-header';
      var prevNav = el('button', { type: 'button', className: 'daterange-month-nav' + (showPrevNav ? '' : ' spacer'), text: '\\u2039' });
      prevNav.addEventListener('click', function () { viewMonth = addMonths(viewMonth, -1); hoverDate = null; renderCalendars(); });
      var title = el('span', { text: monthDate.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }) + ' ' + monthDate.getUTCFullYear() });
      var nextNav = el('button', { type: 'button', className: 'daterange-month-nav' + (showNextNav ? '' : ' spacer'), text: '\\u203a' });
      nextNav.addEventListener('click', function () { viewMonth = addMonths(viewMonth, 1); hoverDate = null; renderCalendars(); });
      header.appendChild(prevNav);
      header.appendChild(title);
      header.appendChild(nextNav);
      wrap.appendChild(header);

      var weekdays = document.createElement('div');
      weekdays.className = 'daterange-weekdays';
      DATERANGE_WEEKDAY_LABELS.forEach(function (w) { weekdays.appendChild(el('span', { text: w })); });
      wrap.appendChild(weekdays);

      var days = document.createElement('div');
      days.className = 'daterange-days';
      var firstOfMonth = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1));
      var leadingBlank = (firstOfMonth.getUTCDay() + 6) % 7; // Monday-start offset
      var daysInMonth = endOfMonth(monthDate).getUTCDate();
      var todayYmd = getKyivTodayYmd();

      for (var i = 0; i < leadingBlank; i++) {
        days.appendChild(el('button', { className: 'daterange-day outside', disabled: 'disabled' }));
      }
      var _loop = function (d) {
        var cellDate = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), d));
        var btn = el('button', { type: 'button', className: computeDayClasses(cellDate, todayYmd, rangeStart, rangeEnd).join(' '), text: String(d) });
        btn.addEventListener('click', function () { onDayClick(cellDate); });
        // Live range preview (see applyHoverHighlight) — a no-op via onDayHover's own guard
        // whenever there's no pending pick to preview against (idle browsing, or a range
        // already committed), so this listener doesn't need its own conditional.
        btn.addEventListener('mouseenter', function () { onDayHover(cellDate); });
        renderedDayButtons.push({ date: cellDate, el: btn });
        days.appendChild(btn);
      };
      for (var d = 1; d <= daysInMonth; d++) _loop(d);
      wrap.appendChild(days);
      return wrap;
    }

    function renderCalendars() {
      var container = document.getElementById(opts.fieldId + '-calendars');
      if (!container) return;
      container.innerHTML = '';
      renderedDayButtons = [];
      var r = currentRange();
      var rangeStart = pendingStart || (r ? r.start : null);
      var rangeEnd = pendingStart ? null : (r ? r.end : null);
      container.appendChild(buildMonthGrid(viewMonth, true, false, rangeStart, rangeEnd));
      container.appendChild(buildMonthGrid(addMonths(viewMonth, 1), false, true, rangeStart, rangeEnd));
      // Cursor leaving the whole calendars area (not just one day cell to another) drops the
      // live preview back to just the pending start day alone — matches Jira's own behavior of
      // not leaving a preview highlighted somewhere the cursor no longer is.
      container.onmouseleave = function () {
        if (!pendingStart) return;
        hoverDate = null;
        applyHoverHighlight();
      };
    }

    // Deliberately NOT popoverEl.contains(e.target) — a day-cell click's own handler
    // (onDayClick) synchronously rebuilds the calendar grid via renderCalendars(), which
    // detaches the just-clicked button from the DOM while THIS SAME click event is still
    // bubbling. .contains() reflects the live tree at the moment it's called, so by the time
    // this listener runs it would see the (now-detached) target as no longer contained in
    // popoverEl and incorrectly close the popover after every single day click. composedPath()
    // is the event's propagation path captured at dispatch time, before any mutation — it still
    // correctly includes popoverEl regardless of what onDayClick did to the DOM afterward.
    function onOutsideClick(e) {
      var path = e.composedPath();
      if (popoverEl && path.indexOf(popoverEl) === -1 && e.target.id !== opts.inputId) closePopover();
    }
    function onKeydown(e) {
      if (e.key === 'Escape') closePopover();
    }

    function buildPopover() {
      var pop = document.createElement('div');
      pop.className = 'daterange-popover';
      pop.hidden = true;

      var presets = document.createElement('div');
      presets.className = 'daterange-presets';
      var todayYmd = getKyivTodayYmd();
      buildDateRangePresets(ymdToDate(todayYmd.y, todayYmd.m, todayYmd.d)).forEach(function (p) {
        var btn = el('button', { type: 'button', className: 'daterange-preset-btn', text: p.label });
        btn.addEventListener('click', function () { applyRange(p.start, p.end); });
        presets.appendChild(btn);
      });
      var clearBtn = el('button', { type: 'button', className: 'daterange-preset-btn clear', text: 'All dates' });
      clearBtn.addEventListener('click', clearRange);
      presets.appendChild(clearBtn);
      pop.appendChild(presets);

      var calendars = document.createElement('div');
      calendars.className = 'daterange-calendars';
      calendars.id = opts.fieldId + '-calendars';
      pop.appendChild(calendars);

      document.body.appendChild(pop);
      return pop;
    }

    function openPopover() {
      if (!popoverEl) popoverEl = buildPopover();
      var r = currentRange();
      var todayYmd = getKyivTodayYmd();
      var anchor = r ? r.start : ymdToDate(todayYmd.y, todayYmd.m, todayYmd.d);
      viewMonth = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
      pendingStart = null;
      hoverDate = null;
      renderCalendars();

      var field = document.getElementById(opts.fieldId);
      var rect = field.getBoundingClientRect();
      popoverEl.style.visibility = 'hidden';
      popoverEl.style.top = (rect.bottom + 6) + 'px';
      popoverEl.style.left = rect.left + 'px';
      popoverEl.hidden = false;
      // Clamp to the viewport — this field can land near the right edge of a busy toolbar, and
      // the popover (presets + two full month calendars) is wide enough to overflow off-screen.
      var popRect = popoverEl.getBoundingClientRect();
      if (popRect.right > window.innerWidth - 8) {
        popoverEl.style.left = Math.max(8, window.innerWidth - popRect.width - 8) + 'px';
      }
      popoverEl.style.visibility = '';

      setTimeout(function () {
        document.addEventListener('click', onOutsideClick);
        document.addEventListener('keydown', onKeydown);
      }, 0);
    }

    function closePopover() {
      if (popoverEl) popoverEl.hidden = true;
      document.removeEventListener('click', onOutsideClick);
      document.removeEventListener('keydown', onKeydown);
    }

    document.getElementById(opts.inputId).addEventListener('click', function () {
      if (popoverEl && !popoverEl.hidden) { closePopover(); return; }
      openPopover();
    });
    document.getElementById(opts.prevBtnId).addEventListener('click', function () { shiftRange(-1); });
    document.getElementById(opts.nextBtnId).addEventListener('click', function () { shiftRange(1); });

    updateFieldUI();
  }

  function isSafeUrl(url) {
    return typeof url === 'string' && /^https?:\\/\\//i.test(url);
  }

  // Wellfound's JSON-LD JobPosting.description genuinely contains HTML markup (<p>, <strong>,
  // lists, links) — confirmed against real stored data. Techjobs/ITjobs descriptions are plain
  // text with none. Both are extracted verbatim from their own site's JSON-LD with identical
  // logic (extension/lib/parsers/techjobs.ts vs. wellfound-detail-extract.ts — no source-
  // specific stripping in either), so this isn't an extraction bug or a rendering-path
  // inconsistency; it's that the sidebar only ever rendered descriptions as plain text
  // (textContent), which happened to look right for two sources and wrong for the third.
  //
  // Allowlist-based sanitizer so the fix works for all three without ever trusting scraped
  // HTML: only these tags survive (everything else is unwrapped — its own tag+attributes
  // discarded, its already-sanitized children kept); every attribute on every surviving
  // element is stripped by default, with only a scheme-validated href restored on <a>. A
  // plain-text description (techjobs/itjobs) has no tags to begin with, so it round-trips
  // through this unchanged — same visible result as before.
  var DESCRIPTION_ALLOWED_TAGS = {
    P: 1, BR: 1, STRONG: 1, B: 1, EM: 1, I: 1, U: 1,
    UL: 1, OL: 1, LI: 1, A: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    BLOCKQUOTE: 1, HR: 1, SPAN: 1, DIV: 1,
  };

  function sanitizeDescriptionNode(parent) {
    Array.from(parent.childNodes).forEach(function (node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        var tag = node.tagName.toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE') {
          parent.removeChild(node);
          return;
        }
        if (!DESCRIPTION_ALLOWED_TAGS[tag]) {
          // Sanitize the disallowed element's own subtree FIRST, then unwrap (hoist its now-
          // clean children up, discard the tag and every attribute it had) — never the other
          // way around, or a nested <script>/dangerous element inside an unknown wrapper tag
          // would survive un-sanitized once hoisted.
          sanitizeDescriptionNode(node);
          while (node.firstChild) parent.insertBefore(node.firstChild, node);
          parent.removeChild(node);
          return;
        }
        var href = tag === 'A' ? node.getAttribute('href') : null;
        Array.from(node.attributes).forEach(function (attr) { node.removeAttribute(attr.name); });
        if (tag === 'A' && isSafeUrl(href)) {
          node.setAttribute('href', href);
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noreferrer');
        }
        sanitizeDescriptionNode(node);
      } else if (node.nodeType !== Node.TEXT_NODE) {
        // Comments, processing instructions, etc. — no legitimate reason to keep them.
        parent.removeChild(node);
      }
    });
  }

  // DOMParser never executes embedded <script> content or fetches resources while parsing —
  // this is the standard safe way to turn an untrusted string into a DOM tree to sanitize.
  function sanitizeDescriptionHtml(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    sanitizeDescriptionNode(doc.body);
    return doc.body.innerHTML;
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

  // Shared by buildSelectAllTh/buildCheckboxTd: makes the WHOLE cell a click target, not just
  // the <input> itself. stopPropagation always runs first — this cell's own listener is what
  // makes that possible, but a click still bubbles past it toward any ancestor listener unless
  // stopped; for buildCheckboxTd specifically, that ancestor is the row's own click-to-open-
  // sidebar handler (buildRow), which a selection click must never also trigger. Harmless for
  // buildSelectAllTh's <th> (no sort listener lives on that particular element — each header
  // cell owns its own independent listener), kept here anyway so both call sites share one
  // rule rather than one of them being a special case.
  //
  // If the click landed directly on the checkbox, the browser has already flipped .checked and
  // will fire its own native 'change' event — nothing more to do here, or a cell-level toggle
  // on top of that would flip it right back. Anywhere else in the cell (padding, the rest of
  // the box), there's no native toggle to piggyback on, so this flips .checked itself and fires
  // a synthetic 'change' — reusing the exact same change listener both paths already share,
  // rather than duplicating the selection-toggling logic here.
  function toggleCheckboxCell(e, checkbox) {
    e.stopPropagation();
    if (e.target === checkbox || checkbox.disabled) return;
    checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Shared by buildSelectAllTh (initial render) and updateSelectAllCheckboxState (the cheap
  // post-toggle path below) — one place computing the header checkbox's checked/indeterminate/
  // disabled state, so the two call sites can't drift out of sync with each other.
  function applySelectAllCheckboxState(checkbox) {
    var visible = getFiltered();
    var selected = visible.filter(function (l) { return bulkState.selected[l.id]; }).length;
    checkbox.disabled = bulkState.inFlight || visible.length === 0;
    checkbox.checked = visible.length > 0 && selected === visible.length;
    checkbox.indeterminate = selected > 0 && selected < visible.length;
  }

  // Header "select all currently filtered" checkbox — scoped to the not-detailed rows in the
  // current filter, same set clicking each row checkbox individually would reach.
  // "Select all currently filtered" — every visible row now (not just not-detailed ones);
  // Enrich/Delete each derive their own eligible subset from whatever ends up selected here.
  function buildSelectAllTh() {
    var th = document.createElement('th');
    th.className = 'checkbox-cell';
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', function () {
      // Deliberately NOT render() — see buildCheckboxTd's own comment on why a selection
      // toggle never needs the full filtered-rows rebuild. This one action DOES change many
      // rows' selected flags at once (unlike a single-row toggle), so — unlike that cheap
      // path — every currently-rendered row checkbox needs its .checked resynced; still much
      // cheaper than recreating each row's DOM from scratch (syncRowCheckboxes just writes an
      // existing property, no element creation).
      getFiltered().forEach(function (l) {
        if (checkbox.checked) bulkState.selected[l.id] = true;
        else delete bulkState.selected[l.id];
      });
      bulkState.status = '';
      syncRowCheckboxes();
      // The native click already set .checked correctly, but never touches .indeterminate —
      // that's a plain DOM property with no automatic link to .checked, so without this it can
      // be left stale (e.g. still true from an earlier partial selection) even once every
      // visible lead is now fully selected or fully deselected. applySelectAllCheckboxState
      // recomputes all three properties from the current (just-updated) bulkState.selected, so
      // this corrects itself regardless of what .indeterminate happened to be before the click.
      applySelectAllCheckboxState(checkbox);
      renderBulkBar();
    });
    th.appendChild(checkbox);
    th.addEventListener('click', function (e) { toggleCheckboxCell(e, checkbox); });
    applySelectAllCheckboxState(checkbox);
    return th;
  }

  // Cheap post-toggle path for a SINGLE row's checkbox (buildCheckboxTd) — deliberately not
  // render(). The clicked checkbox's own .checked is already correct (native toggle, or
  // toggleCheckboxCell's manual flip) and no other row's DOM depends on this lead's selected
  // state, so the only other UI that can go stale is the header "select all" checkbox
  // (checked/indeterminate depends on how many of the currently-visible leads are selected) and
  // the bulk-bar (counts/button labels) — both cheap to recompute without touching <tbody>.
  function onRowSelectionChanged() {
    updateSelectAllCheckboxState();
    renderBulkBar();
  }

  function updateSelectAllCheckboxState() {
    var headerCheckbox = document.querySelector('#header-row th.checkbox-cell input');
    if (headerCheckbox) applySelectAllCheckboxState(headerCheckbox);
  }

  // Used only by the header "select all" toggle (buildSelectAllTh) — writes .checked directly
  // on each already-existing row checkbox (matched via the data-lead-id set in buildCheckboxTd)
  // rather than rebuilding any row's DOM. A plain property write on up to a few thousand
  // existing <input> elements is orders of magnitude cheaper than render()'s buildRow() × N,
  // which recreates every cell (badges, links, selects, their own listeners) from scratch.
  function syncRowCheckboxes() {
    document.querySelectorAll('#table-body input[type=checkbox]').forEach(function (cb) {
      cb.checked = !!bulkState.selected[cb.dataset.leadId];
    });
  }

  // ---- Click-and-drag multi-select over the checkbox column ----
  //
  // Design decision: dragging is a fixed-mode "paint", never a per-row toggle. Whatever the
  // origin row's mousedown does to its own checkbox (select it or deselect it) becomes the
  // mode for the WHOLE gesture — every row the cursor crosses afterward is forced into that
  // same state; a row already in that state is left untouched (idempotent). A "toggle whatever
  // the cursor crosses" model was considered and rejected: the cursor re-crossing a row it
  // already touched (mouse jitter, or dragging back up slightly before continuing down) would
  // flip it AGAIN, silently landing it in the opposite of the intended state with no visual
  // cue anything went wrong. Idempotent painting can't do that — recrossing a row is a no-op.
  // Same model most file managers/mail clients use for their own checkbox-column drag-select.
  var dragSelect = null; // { mode: 'select'|'deselect', rows: HTMLElement[], lastRowIndex: number|null }
  var dragAutoScrollRafId = null;
  var dragAutoScrollDirection = 0;
  var dragLastClientY = null;
  var dragUIUpdatePending = false;
  var DRAG_AUTO_SCROLL_EDGE_PX = 40;
  var DRAG_AUTO_SCROLL_SPEED_PX = 12;

  // Every real row in the table, in visual order — excludes the "No leads match..." empty-state
  // row (its one <td> has no .checkbox-cell). Snapshotted once at drag start (startDragSelect)
  // rather than re-queried on every pointer move: the set of rendered rows can't change mid-drag
  // by construction (nothing here ever calls render()), so re-querying it repeatedly would just
  // be wasted work.
  function getDragSelectableRows() {
    return Array.from(document.getElementById('table-body').children).filter(function (tr) {
      return !!tr.querySelector('td.checkbox-cell');
    });
  }

  // Idempotent — only touches this row if it isn't already in the drag's target state, per the
  // design decision above.
  function applyDragModeToRow(tr) {
    var checkbox = tr.querySelector('td.checkbox-cell input');
    if (!checkbox || checkbox.disabled) return;
    var shouldBeChecked = dragSelect.mode === 'select';
    if (checkbox.checked === shouldBeChecked) return;
    checkbox.checked = shouldBeChecked;
    var leadId = checkbox.dataset.leadId;
    if (shouldBeChecked) bulkState.selected[leadId] = true;
    else delete bulkState.selected[leadId];
  }

  // Paints every row between the last-processed index and the newly-reached index, inclusive —
  // not just the single row currently under the cursor. A fast drag can skip several rows
  // between two consecutive mousemove events (the browser doesn't fire one per pixel), so
  // "only the row at this exact event" would silently miss rows the cursor visibly passed over.
  function paintDragRange(toIndex) {
    var rows = dragSelect.rows;
    var fromIndex = dragSelect.lastRowIndex === null ? toIndex : dragSelect.lastRowIndex;
    var lo = Math.min(fromIndex, toIndex);
    var hi = Math.max(fromIndex, toIndex);
    for (var i = lo; i <= hi; i++) applyDragModeToRow(rows[i]);
    dragSelect.lastRowIndex = toIndex;
  }

  function dragRowIndexAtPoint(clientX, clientY) {
    var el = document.elementFromPoint(clientX, clientY);
    var tr = el ? el.closest('tr') : null;
    if (!tr) return null;
    var idx = dragSelect.rows.indexOf(tr);
    return idx === -1 ? null : idx;
  }

  // Batches the (comparatively expensive, getFiltered()-scanning) header-checkbox/bulk-bar sync
  // to at most once per animation frame — a fast drag can touch many rows within a single
  // mousemove burst, and re-running onRowSelectionChanged() once per ROW rather than once per
  // FRAME would reintroduce exactly the kind of O(rendered-row-count)-per-interaction cost the
  // previous fix eliminated, just triggered by mousemove instead of by render().
  function scheduleDragUIUpdate() {
    if (dragUIUpdatePending) return;
    dragUIUpdatePending = true;
    requestAnimationFrame(function () {
      dragUIUpdatePending = false;
      if (dragSelect) onRowSelectionChanged();
    });
  }

  function updateDragAutoScrollDirection(clientY) {
    var wrap = document.querySelector('.table-wrap');
    var rect = wrap.getBoundingClientRect();
    if (clientY < rect.top + DRAG_AUTO_SCROLL_EDGE_PX && wrap.scrollTop > 0) {
      dragAutoScrollDirection = -1;
    } else if (clientY > rect.bottom - DRAG_AUTO_SCROLL_EDGE_PX && wrap.scrollTop < wrap.scrollHeight - wrap.clientHeight) {
      dragAutoScrollDirection = 1;
    } else {
      dragAutoScrollDirection = 0;
    }
  }

  function handleDragPointerMove(clientY) {
    if (!dragSelect) return;
    dragLastClientY = clientY;
    updateDragAutoScrollDirection(clientY);
    var idx = dragRowIndexAtPoint(dragSelect.lastClientX, clientY);
    if (idx === null) return;
    paintDragRange(idx);
    scheduleDragUIUpdate();
  }

  // Runs continuously (via requestAnimationFrame) for the duration of a drag, independent of
  // whether new mousemove events keep arriving — a user who drags to the edge and then just
  // holds the cursor still there still expects continuous scrolling, which mousemove-only
  // handling could never provide (mousemove doesn't fire for a stationary cursor).
  function dragAutoScrollTick() {
    if (!dragSelect) {
      dragAutoScrollRafId = null;
      return;
    }
    if (dragAutoScrollDirection !== 0) {
      var wrap = document.querySelector('.table-wrap');
      wrap.scrollTop += dragAutoScrollDirection * DRAG_AUTO_SCROLL_SPEED_PX;
      // As the table scrolls under an otherwise-stationary cursor, the row under that fixed
      // screen position keeps changing too — re-run the paint at the last known cursor Y so
      // newly-revealed rows keep getting selected without requiring further mouse movement.
      if (dragLastClientY !== null) handleDragPointerMove(dragLastClientY);
    }
    dragAutoScrollRafId = requestAnimationFrame(dragAutoScrollTick);
  }

  function onDocumentDragMouseMove(e) {
    if (!dragSelect) return;
    dragSelect.lastClientX = e.clientX;
    handleDragPointerMove(e.clientY);
  }

  function onDocumentDragMouseUp() {
    endDragSelect();
  }

  function startDragSelect(originTd, mode) {
    var rows = getDragSelectableRows();
    var originIndex = rows.indexOf(originTd.closest('tr'));
    dragSelect = {
      mode: mode,
      rows: rows,
      lastRowIndex: originIndex === -1 ? null : originIndex,
      lastClientX: null,
    };
    document.body.classList.add('drag-selecting');
    document.addEventListener('mousemove', onDocumentDragMouseMove);
    document.addEventListener('mouseup', onDocumentDragMouseUp);
    if (!dragAutoScrollRafId) dragAutoScrollRafId = requestAnimationFrame(dragAutoScrollTick);
    // Covers the plain-click case (mousedown immediately followed by mouseup, no movement) —
    // gives instant feedback rather than waiting up to one animation frame.
    onRowSelectionChanged();
  }

  function endDragSelect() {
    if (!dragSelect) return;
    dragSelect = null;
    dragAutoScrollDirection = 0;
    dragLastClientY = null;
    document.body.classList.remove('drag-selecting');
    document.removeEventListener('mousemove', onDocumentDragMouseMove);
    document.removeEventListener('mouseup', onDocumentDragMouseUp);
    // Final synchronous sync — guarantees correctness even if a scheduleDragUIUpdate() rAF
    // callback from the last few pixels of movement hadn't fired yet.
    onRowSelectionChanged();
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
    // Not a real column on the lead object (the real fields are company_linkedin_status/urls) —
    // sorts by the first found URL, same "empty string sorts first" behavior every other blank
    // field already gets here.
    if (key === 'company_linkedin') return ((lead.company_linkedin_urls && lead.company_linkedin_urls[0]) || '').toLowerCase();
    var v = lead[key];
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v.toLowerCase() : v;
  }

  function getFiltered() {
    return state.leads.filter(function (lead) {
      if (state.filterIsIt !== 'all' && lead.is_it !== state.filterIsIt) return false;
      if (state.filterStatus !== 'all' && lead.status !== state.filterStatus) return false;
      if (state.filterSource !== 'all' && lead.source_site !== state.filterSource) return false;
      if (state.filterDetail !== 'all' && detailState(lead) !== state.filterDetail) return false;
      // Value comes straight off the lead's own hiring_contact_status ('not_checked' | 'found' |
      // 'not_specified') — no derived helper needed the way detailState() is, since this is
      // already exactly the DB enum value, same relationship the IT filter has to lead.is_it.
      if (state.filterContact !== 'all' && lead.hiring_contact_status !== state.filterContact) return false;
      if (state.filterCompanyLinkedin !== 'all' && lead.company_linkedin_status !== state.filterCompanyLinkedin) return false;
      // Kyiv calendar-day comparison (formatKyiv's own Intl.DateTimeFormat approach), same
      // convention as every other date already shown on this page — plain string comparison of
      // YYYY-MM-DD is chronologically correct since it's already zero-padded/lexicographic.
      // A lead with no date at all never matches an active range (there's nothing to compare).
      if (state.filterPublishedRange) {
        var publishedDay = formatKyiv(lead.published_at, true);
        if (!publishedDay || publishedDay < state.filterPublishedRange.start || publishedDay > state.filterPublishedRange.end) return false;
      }
      if (state.filterScrapedRange) {
        var scrapedDay = formatKyiv(lead.scraped_at || lead.created_at, true);
        if (!scrapedDay || scrapedDay < state.filterScrapedRange.start || scrapedDay > state.filterScrapedRange.end) return false;
      }
      if (state.search) {
        var q = state.search.toLowerCase();
        var titleMatch = (lead.job_title || '').toLowerCase().indexOf(q) !== -1;
        var companyMatch = (lead.company || '').toLowerCase().indexOf(q) !== -1;
        if (!titleMatch && !companyMatch) return false;
      }
      return true;
    });
  }

  // Every currently-selected lead, any detail status — the base set both bulk actions work
  // from. Deliberately NOT re-scoped by getFiltered(): a selection persists across filter
  // changes (see pruneSelection below), so a lead selected under one filter and then hidden by
  // a later filter change should still be acted on when the bulk button is clicked — only
  // "select all" itself is bound to what's visible at click time.
  function getSelectedLeads() {
    return state.leads.filter(function (l) { return bulkState.selected[l.id]; });
  }

  // The subset "Enrich selected" actually acts on — same "not detailed" definition as the
  // single-lead Enrich button and the Detail filter (needsEnrich). Already-detailed leads can
  // still be selected/checked (for bulk delete), they just don't count toward Enrich's N.
  function getSelectedNotDetailedLeads() {
    return getSelectedLeads().filter(needsEnrich);
  }

  // The subset "Backfill contact selected" acts on — Wellfound only (the only source this
  // feature checks) and hiring_contact_status still 'not_checked', so a lead already resolved
  // to 'found'/'not_specified' is never re-visited even if it stays selected across clicks.
  function getSelectedNeedsContactCheck() {
    return getSelectedLeads().filter(function (l) {
      return l.source_site === 'wellfound' && l.hiring_contact_status === 'not_checked';
    });
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
  //
  // Three-way, not a boolean: 'error' (enrichment_error set — a definitive, non-retriable
  // deepening failure, e.g. a Wellfound posting that 404s) needs to be distinguishable from
  // plain 'not_detailed' (never attempted, or a transient failure worth auto-retrying) so
  // automatic Enrich queues can skip the former without skipping the latter, and so the
  // dashboard's Detail filter can surface error-flagged leads for triage instead of them
  // silently blending into "not detailed" forever.
  function detailState(lead) {
    if (lead.enrichment_error) return 'error';
    if (!lead.description && !lead.company_website) return 'not_detailed';
    return 'detailed';
  }

  // Eligible for an AUTOMATIC enrich queue (bulk "Enrich selected" — the single-lead sidebar
  // Enrich button below has its own, deliberately more permissive condition: it stays visible
  // on error-flagged leads too, since clicking it IS the manual retry path for those).
  function needsEnrich(lead) {
    return detailState(lead) === 'not_detailed';
  }

  // Sidebar's "Contact" detail row value. 'found' renders "Name — Role (Location)" (Role/Location
  // each omitted individually when absent — location in particular can be legitimately missing
  // even when a contact was found, see wellfound-detail-extract.ts). 'not_specified' renders the
  // Ukrainian marker — same "Ukrainian value labels, English everything else" convention this
  // dashboard already uses for STATUS_LABELS — so it reads as a definite "checked, nothing there"
  // rather than looking like a blank/never-checked field. 'not_checked' returns '' so
  // buildDetailRow's own '—' fallback applies, same as every other genuinely-empty field.
  function hiringContactDetailValue(lead) {
    if (lead.hiring_contact_status === 'found') {
      var text = lead.hiring_contact_name || '';
      if (lead.hiring_contact_role) text += ' \\u2014 ' + lead.hiring_contact_role;
      if (lead.hiring_contact_location) text += ' (' + lead.hiring_contact_location + ')';
      return text;
    }
    if (lead.hiring_contact_status === 'not_specified') return 'не вказано';
    return '';
  }

  // Sidebar's "Company LinkedIn" detail row — a plain container (not buildDetailRow's own
  // text-value path) since 'found' can hold multiple links, each rendered as its own clickable
  // line rather than mashed into one comma-separated string. Same not_specified/not_checked
  // convention as hiringContactDetailValue above.
  function buildCompanyLinkedinRow(lead) {
    var row = document.createElement('div');
    row.className = 'detail-row';
    row.appendChild(el('span', { className: 'detail-label', text: 'Company LinkedIn' }));

    var valueWrap = document.createElement('span');
    valueWrap.className = 'detail-value';
    if (lead.company_linkedin_status === 'found' && (lead.company_linkedin_urls || []).length > 0) {
      lead.company_linkedin_urls.forEach(function (url, i) {
        if (i > 0) valueWrap.appendChild(document.createElement('br'));
        if (isSafeUrl(url)) {
          valueWrap.appendChild(el('a', { className: 'website-link', href: url, target: '_blank', rel: 'noreferrer', text: url }));
        } else {
          valueWrap.appendChild(document.createTextNode(url));
        }
      });
    } else if (lead.company_linkedin_status === 'not_specified') {
      valueWrap.textContent = 'не вказано';
    } else {
      valueWrap.textContent = '—';
    }
    row.appendChild(valueWrap);
    return row;
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

  // Soft delete — same spot in the sidebar as the Enrich block, but shown unconditionally
  // (any lead can be deleted, not just undetailed ones). Confirmed once, mentioning it's
  // recoverable — distinct from /dashboard/deleted's "Delete permanently" confirm, which is
  // irreversible and worded accordingly.
  // Sits in the Description heading row (openSidebar), not as its own block under the title —
  // returns the pieces separately since the button goes inline with the heading and the
  // status message (failure text only; empty/invisible otherwise) goes on its own line below.
  function buildDeleteControls(lead) {
    var button = el('button', { className: 'delete-btn', type: 'button', text: 'Delete' });
    var statusEl = el('div', { className: 'delete-status' });

    button.addEventListener('click', function () {
      var confirmed = window.confirm(
        'Delete "' + (lead.job_title || '(untitled)') + '"? You can restore it from Deleted leads within ' + LEAD_RETENTION_DAYS + ' days.',
      );
      if (!confirmed) return;

      button.disabled = true;
      statusEl.textContent = '';
      softDeleteLead(lead.id)
        .then(function () {
          closeSidebar();
          loadLeads();
        })
        .catch(function (err) {
          button.disabled = false;
          statusEl.textContent = err.message;
        });
    });

    return { button: button, statusEl: statusEl };
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

    // "Click" half of the warning icon's hover/click contract (buildTitleCell below covers
    // hover, via the icon's native title tooltip) — opening the sidebar is what a click on the
    // row does, so this is where the fuller message lives, plus the actual stored reason.
    if (lead.enrichment_error) {
      content.appendChild(el('div', { className: 'error-banner' }, [
        el('div', { text: ERROR_TOOLTIP_TEXT }),
        el('div', { className: 'error-banner-reason', text: lead.enrichment_error }),
      ]));
    }

    // Shown for 'not_detailed' (never attempted / worth a normal retry) AND 'error' (the
    // explicit manual single-lead retry path for a lead an automatic queue already skipped) —
    // NOT for 'detailed', which has nothing left for this button to add. Deliberately more
    // permissive than needsEnrich() (used for the AUTOMATIC bulk-enrich eligible set), which
    // excludes 'error' on purpose — see needsEnrich's own comment.
    if (detailState(lead) !== 'detailed') {
      content.appendChild(buildEnrichBlock(lead));
    }

    content.appendChild(buildDetailRow('Company', lead.company));
    content.appendChild(buildDetailRow('Website', lead.company_website, true));
    content.appendChild(buildDetailRow('Job link', lead.source_url, true));
    content.appendChild(buildDetailRow('Location', lead.location));
    content.appendChild(buildDetailRow('Contact', hiringContactDetailValue(lead)));
    content.appendChild(buildCompanyLinkedinRow(lead));
    content.appendChild(buildDetailRow('Published', formatKyiv(lead.published_at, true)));
    content.appendChild(buildDetailRow('Source', lead.source_site));
    content.appendChild(buildDetailRow('Status', STATUS_LABELS[lead.status] || lead.status));
    content.appendChild(buildDetailRow('Owner', lead.owner_display_name || lead.owner_email));
    content.appendChild(buildDetailRow('Scraped', formatKyiv(lead.scraped_at || lead.created_at, false)));

    // Delete sits in the Description heading row (right-aligned), after every metadata field
    // above and right before the description text — not the first thing under the title.
    var deleteControls = buildDeleteControls(lead);
    content.appendChild(el('div', { className: 'sidebar-desc-header' }, [
      el('div', { className: 'sidebar-desc-label', text: 'Description' }),
      deleteControls.button,
    ]));
    content.appendChild(deleteControls.statusEl);
    var descEl = el('div', { className: 'sidebar-desc' });
    if (lead.description) {
      descEl.innerHTML = sanitizeDescriptionHtml(lead.description);
    } else {
      descEl.textContent = 'No description yet.';
    }
    content.appendChild(descEl);

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

  // Bulk-select checkbox — every row now, regardless of detail status (bulk delete applies to
  // any lead; bulk enrich just ignores the already-detailed ones it doesn't need — see
  // getSelectedNotDetailedLeads).
  function buildCheckboxTd(lead) {
    var td = document.createElement('td');
    td.className = 'checkbox-cell';

    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = bulkState.inFlight;
    checkbox.checked = !!bulkState.selected[lead.id];
    checkbox.dataset.leadId = lead.id; // read back by syncRowCheckboxes on a "select all" toggle
    // Kept for the keyboard path (Space/Enter on a focused checkbox) — see the click listener
    // below for why the mouse path no longer relies on this at all.
    checkbox.addEventListener('change', function () {
      if (checkbox.checked) bulkState.selected[lead.id] = true;
      else delete bulkState.selected[lead.id];
      bulkState.status = '';
      onRowSelectionChanged();
    });
    td.appendChild(checkbox);

    // Toggling (and starting a possible drag-select) happens here, in mousedown, not in the
    // click handler below — see the "Click-and-drag multi-select" block's design-decision
    // comment for why: a real drag (mousedown then move before releasing) never fires a native
    // 'click' on the origin element at all, so waiting for click/change to learn "what did this
    // row's own click just do" silently fails to start a drag for a real, non-pausing gesture.
    td.addEventListener('mousedown', function (e) {
      if (checkbox.disabled || e.button !== 0) return;
      // Suppresses native text-selection-drag (and focus transfer) — does NOT cancel the
      // later 'click' event's own default action, which the click listener below handles
      // separately.
      e.preventDefault();
      checkbox.checked = !checkbox.checked;
      if (checkbox.checked) bulkState.selected[lead.id] = true;
      else delete bulkState.selected[lead.id];
      bulkState.status = '';
      startDragSelect(td, checkbox.checked ? 'select' : 'deselect');
    });
    td.addEventListener('click', function (e) {
      // Keyboard activation (Space/Enter on a focused checkbox) synthesizes a click with
      // detail === 0 — the standard way to tell it apart from a real mouse click (always
      // detail >= 1). Nothing has toggled this yet for that case (mousedown above never fired),
      // so let the browser's native default run normally, which fires this checkbox's own
      // 'change' listener above. Still stop it from bubbling into the row's own
      // click-to-open-sidebar handler.
      if (e.detail === 0) {
        e.stopPropagation();
        return;
      }
      // Real mouse click — mousedown already did the actual toggle above. Without this, the
      // browser's own default click behavior would flip .checked (and fire a second, native
      // 'change') right back, undoing what mousedown just did.
      e.preventDefault();
      e.stopPropagation();
    });
    return td;
  }

  // Briefly outlines a field in --error and shows the failure as a native tooltip — used for
  // row-level write failures (status change) where there's no dedicated message slot the way
  // the sidebar's enrich/delete blocks have one.
  function flashFieldError(fieldEl, message) {
    fieldEl.title = message;
    fieldEl.classList.add('field-error');
    setTimeout(function () { fieldEl.classList.remove('field-error'); }, 2500);
  }

  // Inline status editor (FEATURE 1) — same status values/labels as the Status filter and the
  // extension side panel's per-lead dropdown (STATUS_OPTIONS in lib/status-labels.ts), same
  // "change fires an immediate PATCH, no save button" UX. Optimistic-ish: reverts to the prior
  // value on failure rather than trusting the click.
  function buildStatusTd(lead) {
    var td = document.createElement('td');
    var select = document.createElement('select');
    select.className = 'status-select';
    Object.keys(STATUS_LABELS).forEach(function (value) {
      select.appendChild(el('option', { value: value, text: STATUS_LABELS[value] }));
    });
    select.value = lead.status;

    select.addEventListener('click', function (e) { e.stopPropagation(); });
    select.addEventListener('change', function () {
      var next = select.value;
      var previous = lead.status;
      select.disabled = true;
      updateLeadStatus(lead.id, next)
        .then(function (updated) {
          lead.status = updated.status;
          select.disabled = false;
        })
        .catch(function (err) {
          select.value = previous;
          select.disabled = false;
          flashFieldError(select, err.message);
        });
    });

    td.appendChild(select);
    return td;
  }

  // Table cell for the "Company LinkedIn" column — compact "Open ↗" (+N more) rather than the
  // full URL text company_website's own column uses, since a found lead can hold several links
  // and a raw URL list would blow out the row width. Same not_specified/not_checked convention
  // as the sidebar's buildCompanyLinkedinRow (не вказано / —), just condensed for table density.
  function buildCompanyLinkedinTd(lead) {
    var td = document.createElement('td');
    var urls = lead.company_linkedin_urls || [];
    if (lead.company_linkedin_status === 'found' && urls.length > 0) {
      if (isSafeUrl(urls[0])) {
        var a = el('a', { className: 'website-link', href: urls[0], target: '_blank', rel: 'noreferrer', text: 'Open \\u2197' });
        a.addEventListener('click', function (e) { e.stopPropagation(); });
        td.appendChild(a);
      } else {
        td.appendChild(document.createTextNode(urls[0]));
      }
      if (urls.length > 1) {
        td.appendChild(document.createTextNode(' (+' + (urls.length - 1) + ' more)'));
      }
    } else if (lead.company_linkedin_status === 'not_specified') {
      td.textContent = 'не вказано';
    } else {
      td.textContent = '\\u2014';
    }
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

    var titleTd = document.createElement('td');
    titleTd.className = 'title-cell';
    titleTd.appendChild(document.createTextNode(lead.job_title || '(untitled)'));
    if (lead.enrichment_error) {
      // Hover half of the warning icon's hover/click contract — click is covered by the row's
      // own click-to-open-sidebar handler above, where the fuller error banner lives.
      titleTd.appendChild(el('span', { className: 'error-icon', title: ERROR_TOOLTIP_TEXT, text: '!' }));
    }
    tr.appendChild(titleTd);
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
    tr.appendChild(buildCompanyLinkedinTd(lead));

    tr.appendChild(el('td', { text: lead.location || '\\u2014' }));
    tr.appendChild(buildStatusTd(lead));
    tr.appendChild(el('td', { text: lead.owner_display_name || lead.owner_email || '\\u2014' }));
    tr.appendChild(el('td', { text: formatKyiv(lead.scraped_at || lead.created_at, false) || '\\u2014' }));

    return tr;
  }

  // Drops selections for leads that no longer exist (deleted elsewhere, purged, gone after a
  // reload) — keeps them across filter/sort changes and across becoming detailed otherwise,
  // since selection is no longer tied to detail status; only presence in state.leads matters.
  function pruneSelection() {
    var stillPresent = {};
    state.leads.forEach(function (lead) { stillPresent[lead.id] = true; });
    Object.keys(bulkState.selected).forEach(function (id) {
      if (!stillPresent[id]) delete bulkState.selected[id];
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
    var enrichBtn = document.getElementById('bulk-enrich-btn');
    var contactBtn = document.getElementById('bulk-contact-btn');
    var linkedinBtn = document.getElementById('bulk-company-linkedin-btn');
    var deleteBtn = document.getElementById('bulk-delete-btn');
    var statusEl = document.getElementById('bulk-status');
    var notDetailedCount = getSelectedNotDetailedLeads().length;
    var needsContactCount = getSelectedNeedsContactCheck().length;
    var needsLinkedinCount = getSelectedNeedsCompanyLinkedinCheck().length;

    if (bulkState.inFlight && bulkState.mode === 'enrich') {
      countEl.textContent = 'Enriching ' + bulkState.completed + '/' + bulkState.total + '\\u2026';
    } else if (bulkState.inFlight && bulkState.mode === 'contact') {
      countEl.textContent = 'Checking contacts ' + bulkState.completed + '/' + bulkState.total + '\\u2026';
    } else if (bulkState.inFlight && bulkState.mode === 'linkedin') {
      countEl.textContent = 'Checking company LinkedIn ' + bulkState.completed + '/' + bulkState.total + '\\u2026';
    } else if (bulkState.inFlight && bulkState.mode === 'delete') {
      countEl.textContent = 'Deleting\\u2026';
    } else {
      countEl.textContent = count + ' selected';
    }

    // Enrich only ever acts on the not-detailed subset of the selection — disabled (not
    // hidden) when that subset is empty, same as every other "nothing to do" disabled state
    // already used elsewhere on this page (filters, other buttons).
    enrichBtn.textContent = 'Enrich selected (' + notDetailedCount + ')';
    enrichBtn.disabled = bulkState.inFlight || notDetailedCount === 0;

    // Same "disabled when nothing eligible" pattern as Enrich above — eligible set is
    // Wellfound + still-not_checked (see getSelectedNeedsContactCheck).
    contactBtn.textContent = 'Backfill contact selected (' + needsContactCount + ')';
    contactBtn.disabled = bulkState.inFlight || needsContactCount === 0;

    // Uncapped count here (the true eligible-in-selection total) — the 50/run cap is enforced
    // server-side, with any excess reported as skippedCap in the run summary rather than
    // silently hidden from this label.
    linkedinBtn.textContent = 'Backfill LinkedIn selected (' + needsLinkedinCount + ')';
    linkedinBtn.disabled = bulkState.inFlight || needsLinkedinCount === 0;

    deleteBtn.textContent = 'Delete selected (' + count + ')';
    deleteBtn.disabled = bulkState.inFlight || count === 0;

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
      })
      .then(loadStats);
  }

  var STAT_IS_IT_LABELS = { it: 'IT', not_it: 'not-IT', unprocessed: 'Unprocessed' };

  function buildStatChip(label, count) {
    return el('span', { className: 'stat-chip' }, [
      el('span', { text: label }),
      el('span', { className: 'stat-chip-count', text: String(count) }),
    ]);
  }

  // Stats strip (GET /leads/stats): global counts, computed server-side over ALL non-deleted
  // leads regardless of whatever's currently filtered/searched on the table — a deliberately
  // separate query from the table's own data, not a client-side count of getFiltered()/state.leads.
  function renderStats(stats) {
    document.getElementById('stat-total').textContent = String(stats.total);
    document.getElementById('stat-new-today').textContent = String(stats.newToday);

    var sourceBody = document.getElementById('stat-by-source');
    sourceBody.innerHTML = '';
    var sources = Object.keys(stats.bySource).sort();
    if (sources.length === 0) {
      sourceBody.appendChild(el('span', { className: 'stat-chip', text: 'No leads yet' }));
    } else {
      sources.forEach(function (source) {
        sourceBody.appendChild(buildStatChip(source, stats.bySource[source]));
      });
    }

    var isItBody = document.getElementById('stat-by-is-it');
    isItBody.innerHTML = '';
    ['it', 'not_it', 'unprocessed'].forEach(function (key) {
      isItBody.appendChild(buildStatChip(STAT_IS_IT_LABELS[key], stats.byIsIt[key] || 0));
    });
  }

  // Runs after every loadLeads() (initial load, Refresh, and every action that already calls
  // loadLeads() to refresh the table — status change, delete, restore, enrich) so the strip
  // never goes stale without needing its own separate set of call sites. A failure here is
  // non-fatal — the main table is the page's actual job, so it degrades quietly rather than
  // blocking or erroring the rest of the page.
  function loadStats() {
    return apiFetch('/leads/stats').then(renderStats).catch(function () {
      var strip = document.getElementById('stats-strip');
      if (strip) strip.textContent = 'Stats unavailable.';
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

    // Only the not-detailed subset of the selection — already-detailed selected leads (there
    // for bulk delete's benefit) are silently skipped here, same as this button always ignored
    // rows outside its own eligible set.
    var targets = getSelectedNotDetailedLeads()
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
    bulkState.mode = 'enrich';
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
      bulkState.mode = null;
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

  function buildContactBulkSummary(result) {
    if (!result || !result.ok) {
      return (result && result.error) || 'Backfill contact failed.';
    }
    var parts = [result.found + ' found'];
    if (result.notSpecified) parts.push(result.notSpecified + ' not specified');
    if (result.unresolved) parts.push(result.unresolved + ' unresolved (left for a later run)');
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

  // Bulk "Backfill contact selected" — background.ts's BACKFILL_CONTACT_LEADS handler, same
  // Port/connection mechanics as startBulkEnrich above (reused verbatim: extension-id lookup,
  // timeout, PROGRESS/DONE message shape) just a different message type and result shape.
  function startBulkContactBackfill() {
    if (bulkState.inFlight) return;

    var targets = getSelectedNeedsContactCheck()
      .map(function (l) { return { leadId: l.id, sourceSite: l.source_site, sourceUrl: l.source_url }; });
    if (targets.length === 0) return;

    var extId = (localStorage.getItem(EXTENSION_ID_STORAGE_KEY) || '').trim();
    if (!extId) {
      bulkState.status = 'Set the Extension ID above first (see chrome://extensions), then try again.';
      render();
      return;
    }
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.connect) {
      bulkState.status = 'Install or open the Sales Manager extension in this browser to check contacts.';
      render();
      return;
    }

    bulkState.inFlight = true;
    bulkState.mode = 'contact';
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
      bulkState.mode = null;
      bulkState.status = buildContactBulkSummary(result);
      clearSelection();
      render();
      loadLeads();
    }

    var port;
    try {
      port = chrome.runtime.connect(extId, { name: BULK_ENRICH_PORT_NAME });
    } catch (err) {
      finish({ ok: false, error: 'Install or open the Sales Manager extension in this browser to check contacts.' });
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

    port.onDisconnect.addListener(function () {
      finish({ ok: false, error: 'Install or open the Sales Manager extension in this browser to check contacts.' });
    });

    try {
      port.postMessage({ type: 'BACKFILL_CONTACT_LEADS', leads: targets });
    } catch (err) {
      finish({ ok: false, error: 'Install or open the Sales Manager extension in this browser to check contacts.' });
    }
  }

  // Bulk "Delete selected" — unlike bulk enrich, a plain DB write (PATCH /leads/bulk-delete),
  // so no extension/messaging round-trip is needed; applies to the whole selection regardless
  // of detail status. One confirm() for the whole batch, matching the "recoverable, mention
  // the retention window" wording used for the single-lead delete confirm below.
  function startBulkDelete() {
    if (bulkState.inFlight) return;

    var targets = getSelectedLeads();
    if (targets.length === 0) return;

    var confirmed = window.confirm(
      'Delete ' + targets.length + ' lead' + (targets.length === 1 ? '' : 's') + '? ' +
        'You can restore ' + (targets.length === 1 ? 'it' : 'them') + ' from Deleted leads within ' + LEAD_RETENTION_DAYS + ' days.',
    );
    if (!confirmed) return;

    bulkState.inFlight = true;
    bulkState.mode = 'delete';
    bulkState.status = '';
    render();

    apiFetch('/leads/bulk-delete', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds: targets.map(function (l) { return l.id; }) }),
    })
      .then(function (result) {
        var n = result && typeof result.deleted === 'number' ? result.deleted : targets.length;
        bulkState.status = n + ' lead' + (n === 1 ? '' : 's') + ' deleted';
      })
      .catch(function (err) {
        bulkState.status = err.message;
      })
      .then(function () {
        bulkState.inFlight = false;
        bulkState.mode = null;
        clearSelection();
        render();
        loadLeads();
      });
  }

  // Company-LinkedIn discovery (CLAUDE.md) — row-selection-scoped like the other bulk-bar
  // actions above (same bulkState.inFlight/mode gating, so this and Enrich/Backfill
  // contact/Delete can never run concurrently from this tab), but still a server-side job under
  // the hood (company-linkedin.service.ts): the POST returns immediately and this tab polls
  // GET status for progress, same reasoning as before — no CORS-safe way for this page's own JS
  // to read an arbitrary external site's response body, so the real fetch has to be server-side
  // regardless of how the batch gets chosen. Unlike Wellfound's bulk actions, closing this tab
  // does NOT stop an in-flight run (it's not extension-driven) — worth knowing, though the UI
  // here doesn't call special attention to it the way the old standalone banner did, to match
  // the other three buttons' plain "Xing N/M…" bulk-bar treatment.
  var COMPANY_LINKEDIN_POLL_MS = 1000;
  var companyLinkedinPollId = null;

  // Selected leads still eligible for a check: not yet checked AND actually has a
  // company_website to fetch — same "eligible subset of the selection" pattern as
  // getSelectedNotDetailedLeads/getSelectedNeedsContactCheck above. Uncapped here (the button's
  // own label shows the true selected-eligible count); COMPANY_LINKEDIN_RUN_CAP (50) is enforced
  // server-side, with the untried remainder reported back as skippedCap in the run summary.
  function getSelectedNeedsCompanyLinkedinCheck() {
    return getSelectedLeads().filter(function (l) {
      return !!l.company_website && l.company_linkedin_status === 'not_checked';
    });
  }

  function buildCompanyLinkedinBulkSummary(result) {
    var parts = [result.found + ' found'];
    if (result.notSpecified) parts.push(result.notSpecified + ' not specified');
    if (result.skippedCap) parts.push(result.skippedCap + ' skipped \\u2014 over the 50/run cap');
    if (result.skippedIneligible) parts.push(result.skippedIneligible + ' already resolved/ineligible, skipped');
    return parts.join(', ');
  }

  function pollCompanyLinkedinBulkStatus() {
    apiFetch('/leads/company-linkedin/status')
      .then(function (status) {
        bulkState.completed = status.processed;
        bulkState.total = status.total;
        render();

        if (status.running) {
          if (!companyLinkedinPollId) {
            companyLinkedinPollId = setInterval(pollCompanyLinkedinBulkStatus, COMPANY_LINKEDIN_POLL_MS);
          }
          return;
        }

        if (companyLinkedinPollId) {
          clearInterval(companyLinkedinPollId);
          companyLinkedinPollId = null;
        }
        bulkState.inFlight = false;
        bulkState.mode = null;
        bulkState.status = buildCompanyLinkedinBulkSummary(status);
        clearSelection();
        render();
        loadLeads();
      })
      .catch(function () {
        // Best-effort — a failed status poll shouldn't spam errors or abort the run; the next
        // interval tick just retries. The run itself is unaffected (it's server-side).
      });
  }

  // Bulk "Backfill LinkedIn selected" — see company-linkedin.service.ts's startBackfill for how
  // the >50-selected case is handled: the server filters the selection down to eligible leads,
  // caps at COMPANY_LINKEDIN_RUN_CAP (50), and reports both skippedCap (eligible but over the
  // cap) and skippedIneligible (already resolved, or no company_website) counts back separately
  // in the final summary — never silently drops either.
  function startBulkCompanyLinkedin() {
    if (bulkState.inFlight) return;

    var targets = getSelectedNeedsCompanyLinkedinCheck().map(function (l) { return l.id; });
    if (targets.length === 0) return;

    bulkState.inFlight = true;
    bulkState.mode = 'linkedin';
    bulkState.completed = 0;
    bulkState.total = Math.min(targets.length, 50);
    bulkState.status = '';
    render();

    apiFetch('/leads/company-linkedin/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds: targets }),
    })
      .then(function (result) {
        if (!result.started) {
          // "Already running" (e.g. triggered from another tab) is a real in-progress run this
          // tab should still attach its own progress polling to — anything else (nothing
          // eligible after server-side filtering) is a one-off message and there's nothing to
          // poll.
          if (result.alreadyRunning) {
            bulkState.total = 0;
            pollCompanyLinkedinBulkStatus();
            return;
          }
          bulkState.inFlight = false;
          bulkState.mode = null;
          bulkState.status = result.reason || 'Nothing to backfill.';
          render();
          return;
        }
        // skippedIneligible/skippedCap are set once server-side at run start and stay on
        // CompanyLinkedinStatus for the run's whole lifetime, so pollCompanyLinkedinBulkStatus's
        // completion summary (built from GET status) picks them up without this needing to pass
        // them along itself.
        bulkState.total = result.total;
        render();
        pollCompanyLinkedinBulkStatus();
      })
      .catch(function (err) {
        bulkState.inFlight = false;
        bulkState.mode = null;
        bulkState.status = err.message;
        render();
      });
  }

  // Light/dark toggle. The DOM attribute (set by the inline <head> script before first paint,
  // or defaulted to absent = dark) is the single source of truth — read from it rather than
  // tracking a separate JS variable that could drift out of sync with what's actually painted.
  var SUN_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>';
  var MOON_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z" /></svg>';

  function getCurrentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function renderThemeToggle() {
    var theme = getCurrentTheme();
    var isLight = theme === 'light';
    document.getElementById('theme-toggle-track').className = 'theme-toggle-track ' + theme;
    document.getElementById('theme-toggle-thumb').innerHTML = isLight ? SUN_ICON_SVG : MOON_ICON_SVG;
    var label = isLight ? 'Switch to dark mode' : 'Switch to light mode';
    var btn = document.getElementById('theme-toggle');
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch (e) {}
    renderThemeToggle();
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
  document.getElementById('filter-contact').addEventListener('change', function (e) {
    state.filterContact = e.target.value;
    render();
  });
  document.getElementById('filter-company-linkedin').addEventListener('change', function (e) {
    state.filterCompanyLinkedin = e.target.value;
    render();
  });
  createDateRangeFilter({
    stateKey: 'filterPublishedRange',
    fieldId: 'filter-published-range-field',
    inputId: 'filter-published-range-input',
    prevBtnId: 'filter-published-range-prev',
    nextBtnId: 'filter-published-range-next',
  });
  createDateRangeFilter({
    stateKey: 'filterScrapedRange',
    fieldId: 'filter-scraped-range-field',
    inputId: 'filter-scraped-range-input',
    prevBtnId: 'filter-scraped-range-prev',
    nextBtnId: 'filter-scraped-range-next',
  });
  var searchDebounceId = null;
  document.getElementById('search-input').addEventListener('input', function (e) {
    var value = e.target.value;
    clearTimeout(searchDebounceId);
    searchDebounceId = setTimeout(function () {
      state.search = value.trim();
      render();
    }, 300);
  });
  document.getElementById('refresh-btn').addEventListener('click', loadLeads);

  buildExportPanelColumns();
  document.getElementById('export-btn').addEventListener('click', function () {
    setExportModalOpen(true);
  });
  document.getElementById('export-modal-backdrop').addEventListener('click', function () {
    setExportModalOpen(false);
  });
  document.getElementById('export-modal-cancel').addEventListener('click', function () {
    setExportModalOpen(false);
  });
  document.getElementById('export-select-all').addEventListener('click', function () {
    document.querySelectorAll('#export-panel-columns input[type=checkbox]').forEach(function (cb) { cb.checked = true; });
  });
  document.getElementById('export-select-none').addEventListener('click', function () {
    document.querySelectorAll('#export-panel-columns input[type=checkbox]').forEach(function (cb) { cb.checked = false; });
  });
  document.getElementById('export-columns-submit').addEventListener('click', function () {
    var checked = Array.prototype.slice
      .call(document.querySelectorAll('#export-panel-columns input[type=checkbox]:checked'))
      .map(function (cb) { return cb.value; });
    if (checked.length === 0) {
      setExportStatus('Select at least one column.', true);
      return;
    }
    setExportModalOpen(false);
    runExport(checked);
  });

  document.getElementById('bulk-enrich-btn').addEventListener('click', startBulkEnrich);
  document.getElementById('bulk-contact-btn').addEventListener('click', startBulkContactBackfill);
  document.getElementById('bulk-company-linkedin-btn').addEventListener('click', startBulkCompanyLinkedin);
  document.getElementById('bulk-delete-btn').addEventListener('click', startBulkDelete);

  var extensionIdInput = document.getElementById('extension-id');
  extensionIdInput.value = localStorage.getItem(EXTENSION_ID_STORAGE_KEY) || '';
  extensionIdInput.addEventListener('input', function (e) {
    localStorage.setItem(EXTENSION_ID_STORAGE_KEY, e.target.value.trim());
  });
  document.getElementById('theme-toggle').addEventListener('click', function () {
    applyTheme(getCurrentTheme() === 'light' ? 'dark' : 'light');
  });
  // Syncs the toggle's own icon/track with whatever the inline <head> script already decided
  // (or the dark default) — the page-wide colors are already correct at this point via CSS,
  // this is only bringing the toggle widget itself in line.
  renderThemeToggle();
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
    if (e.key !== 'Escape') return;
    closeSidebar();
    if (document.getElementById('export-modal').classList.contains('open')) setExportModalOpen(false);
  });

  renderHeader();
  loadLeads();
})();
</script>
</body>
</html>`;
}
