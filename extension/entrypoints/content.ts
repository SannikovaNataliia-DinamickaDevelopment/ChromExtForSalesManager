import { TechjobsListParser } from '../lib/parsers/techjobs';
import { DevitjobsListParser } from '../lib/parsers/devitjobs';
import { WellfoundListParser } from '../lib/parsers/wellfound';
import { findIndeedNextPageUrl, findIndeedTotalJobCount, IndeedListParser } from '../lib/parsers/indeed';
import { extractIndeedJobDescription } from '../lib/indeed-detail-extract';
import { extractWellfoundJobPosting } from '../lib/wellfound-detail-extract';
import type { SiteParser } from '../lib/types';

// NFR-14: parser adapters are isolated — the coordinator below only ever picks
// a parser by hostname, it never branches on site-specific parsing logic.
// itjobs.ca is the same template as techjobs.ca (confirmed against spikes/itjobs_list.html
// and spikes/itjobs_detail.html — identical card markup and JSON-LD JobPosting shape), so it
// reuses TechjobsListParser with its own source_site/base_url instead of a new parser class.
// DI-2966, Priority #1 (11.09 call). Indeed runs a separate subdomain per country/locale
// (ua.indeed.com, ca.indeed.com, ... dozens more) — the 14.09 spike only confirmed
// www.indeed.com, which is why testing on ua.indeed.com (23.09 follow-up: Nataliia's actual
// test site) initially found no parsing support at all: neither PARSERS below nor matches/
// host_permissions/SUPPORTED_HOSTS had any entry for it. Fixed by explicitly listing the
// hostnames actually needed so far, same "one entry per real hostname" convention as
// devitjobs.nl/www.devitjobs.nl below — NOT a wildcard match pattern, since PARSERS is a plain
// dictionary keyed by exact location.hostname; a `*.indeed.com` match pattern in matches/
// host_permissions alone would get the content script injected but this lookup would still fail
// with "No parser registered for ..." on any hostname not listed here. This list is NOT
// exhaustive — hitting a different Indeed locale needs its hostname added here AND to
// content_scripts' matches below AND to wxt.config.ts's host_permissions AND to
// lib/backend.ts's SUPPORTED_HOSTS (all four must stay in sync; this file's dispatcher can't
// parse a hostname the manifest never injected the content script into in the first place). One
// shared instance across every hostname — IndeedListParser is stateless/hostname-agnostic
// (unlike TechjobsListParser above, it takes no per-deployment constructor args).
const indeedParser = new IndeedListParser();

const PARSERS: Record<string, SiteParser> = {
  'www.techjobs.ca': new TechjobsListParser('techjobs', 'https://www.techjobs.ca'),
  'www.itjobs.ca': new TechjobsListParser('itjobs', 'https://www.itjobs.ca'),
  'www.devitjobs.nl': new DevitjobsListParser(),
  'devitjobs.nl': new DevitjobsListParser(),
  'wellfound.com': new WellfoundListParser(),
  'www.indeed.com': indeedParser,
  'indeed.com': indeedParser,
  'ca.indeed.com': indeedParser,
  'ua.indeed.com': indeedParser,
};

// CLAUDE.md scope D (Wellfound deepening): how long to poll a detail page's DOM for the
// JSON-LD JobPosting before giving up. Not just tabs.onUpdated 'complete' — Next.js hydration
// can finish after network-idle, per the manager's own spec for this feature.
const WELLFOUND_POLL_INTERVAL_MS = 400;
const WELLFOUND_POLL_TIMEOUT_MS = 15000;

// Confirmed live against a real dead posting URL: Wellfound renders a genuine Next.js 404 page
// with this exact document.title, immediately (no JSON-LD JobPosting ever appears for it). A
// removed/expired posting is normal site behavior, not a sign of bot detection — distinguishing
// it lets the caller (wellfound-deepen.ts) flag the lead and move on instead of waiting out the
// full 15s poll and being miscounted as a possible-block failure toward the circuit breaker.
const WELLFOUND_NOT_FOUND_TITLE = '404: Page not found';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Also covers a DataDome challenge page shown instead of the real job page: it never gets a
// JobPosting JSON-LD either, so it falls through to the same timeout/failure path — no
// separate challenge-page detection needed. A definitive 404 (see WELLFOUND_NOT_FOUND_TITLE)
// short-circuits immediately instead, since polling further can't change that outcome.
async function pollForWellfoundDetail() {
  const start = Date.now();
  while (Date.now() - start < WELLFOUND_POLL_TIMEOUT_MS) {
    if (document.title === WELLFOUND_NOT_FOUND_TITLE) {
      return {
        ok: false as const,
        notFound: true as const,
        error: 'This posting no longer exists on Wellfound (404) — likely removed or expired.',
      };
    }
    const detail = extractWellfoundJobPosting(document);
    if (detail) return { ok: true as const, detail };
    await sleep(WELLFOUND_POLL_INTERVAL_MS);
  }
  return {
    ok: false as const,
    notFound: false as const,
    error: 'Timed out waiting for job posting data (15s) — possibly a bot-detection challenge page.',
  };
}

// DI-2966 follow-up (24.09): Indeed deepening moved from a plain fetch (confirmed 403'd by
// Indeed's anti-bot for every request — see indeed-deepen.ts) to this same "real tab, poll for
// embedded data" pattern as Wellfound above. Indeed's own out-of-stock/removed-posting page
// behavior is unconfirmed (unlike WELLFOUND_NOT_FOUND_TITLE's live-verified document.title
// check), so there's deliberately no distinct not-found short-circuit here yet — every failure
// (timeout, block, genuinely-removed posting) falls through to the same generic timeout message
// below and counts toward indeed-deepen.ts's circuit breaker the same way. Revisit if Indeed's
// removed-posting page turns out to have its own reliable signal worth special-casing.
const INDEED_POLL_INTERVAL_MS = 400;
const INDEED_POLL_TIMEOUT_MS = 15000;

async function pollForIndeedDetail() {
  const start = Date.now();
  while (Date.now() - start < INDEED_POLL_TIMEOUT_MS) {
    const detail = extractIndeedJobDescription(document);
    if (detail) return { ok: true as const, detail };
    await sleep(INDEED_POLL_INTERVAL_MS);
  }
  return {
    ok: false as const,
    error: 'Timed out waiting for job description data (15s) — possibly a bot-detection challenge page, a removed posting, or a page-structure change.',
  };
}

// On-page "Parsing in progress" overlay (demo feedback: the side panel's own banner —
// App.tsx's .parsing-banner — wasn't visible enough since a manager's attention is often on
// the job site tab itself, not the panel; a follow-up round of feedback then upgraded this
// from a top-right corner toast to a full-page backdrop, since a corner toast was still easy
// to miss). background.ts's parseActiveTab() shows/hides this on the exact same span as the
// side panel banner (SHOW right before it, HIDE in a finally covering every exit path —
// success, failure, or content-script-unreachable). Same message, distinct element: this is
// specifically about the parse step's "stay on this tab" constraint, not the Wellfound
// deepening flow's "keep the panel open, tab can change" constraint below it.
const PARSE_OVERLAY_HOST_ID = 'sm-parse-overlay-host';

// Wellfound background-window overlay (wellfound-background-window.ts): same visual treatment
// as the parse overlay below, distinct host id/element so the two can never collide even though
// in practice only one of them is ever relevant to a given tab at a time. Shown for the
// duration the dedicated background window is open and doing work (deepening or pagination),
// re-injected after every navigation since a fresh page load wipes the previous one's DOM —
// see wellfound-background-window.ts's navigate().
const BACKGROUND_OVERLAY_HOST_ID = 'sm-background-overlay-host';

// Shared by both overlays below: shadow DOM + all inline styles (no external stylesheet, no
// class names the host page could coincidentally override) — these are third-party sites we
// don't control, so nothing here may depend on — or leak into — the host page's own CSS.
// `:host { all: initial }` strips whatever inherited properties (font, color, line-height,
// etc.) would otherwise cross the shadow boundary from the host page's ancestors before this
// file's own styles apply.
//
// Colors are the corporate dark-theme palette values, hardcoded (same numbers as
// extension/entrypoints/sidepanel/style.css's :root block and the dashboard's — see that
// file's comment on why dark/light are kept numerically identical, not re-derived). Both
// overlays always use the dark-theme values regardless of the user's own side panel/dashboard
// theme preference, since they paint on a third-party page with no relation to that setting —
// same choice already made for the corner-toast version the parse overlay replaced.
//   --accent  #A78BC4  → rgb(167, 139, 196) — backdrop tint
//   --pink    #C97FB0  → card border / spinner accent
//   --panel   #211826  → card background
function createFullPageOverlay(hostId: string, message: string, blocksClicks: boolean): void {
  if (document.getElementById(hostId)) return; // already showing — idempotent

  const host = document.createElement('div');
  host.id = hostId;
  // Full-viewport backdrop, not a corner toast: covers the whole page so it's impossible to
  // miss regardless of where the user's attention is. z-index 2147483647 (max signed 32-bit)
  // is the conventional "always on top" value for extension-injected UI.
  //
  // pointer-events: the parse overlay deliberately BLOCKS clicks on the underlying page for the
  // (~1s in practice) duration of the parse — a full-page modal treatment, not a passive corner
  // notice, so letting clicks fall through underneath would read as a rendering glitch. The
  // background-window overlay does NOT block clicks: that window is minimized/unfocused by
  // design (CLAUDE.md's TabDeepening spec) and never meant to be interacted with directly, so
  // there's nothing to protect against — it's a visual warning only, not a modal.
  host.style.cssText = `position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:${blocksClicks ? 'auto' : 'none'};`;

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .backdrop {
        position: fixed;
        inset: 0;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(167, 139, 196, 0.3);
      }
      .card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 14px;
        padding: 28px 36px;
        border-radius: 12px;
        background: #211826;
        border: 1px solid #C97FB0;
        color: #FFFFFF;
        font-family: 'Poppins', system-ui, sans-serif;
        font-size: 15px;
        font-weight: 500;
        line-height: 1.4;
        text-align: center;
        max-width: 320px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
      }
      .spinner {
        width: 28px;
        height: 28px;
        flex: 0 0 auto;
        border: 3px solid rgba(167, 139, 196, 0.35);
        border-top-color: #C97FB0;
        border-radius: 50%;
        animation: sm-parse-spin 0.7s linear infinite;
      }
      @keyframes sm-parse-spin {
        to { transform: rotate(360deg); }
      }
    </style>
    <div class="backdrop" role="status" aria-live="polite">
      <div class="card">
        <span class="spinner" aria-hidden="true"></span>
        <span>${message}</span>
      </div>
    </div>
  `;

  // documentElement, not body: some sites apply transform/filter to <body>, which would turn
  // it into a containing block for position:fixed descendants and break "pinned to viewport."
  // <html> is the least likely ancestor to have that.
  document.documentElement.appendChild(host);
}

// On-page "Parsing in progress" overlay (demo feedback: the side panel's own banner —
// App.tsx's .parsing-banner — wasn't visible enough since a manager's attention is often on
// the job site tab itself, not the panel; a follow-up round of feedback then upgraded this
// from a top-right corner toast to a full-page backdrop, since a corner toast was still easy
// to miss). background.ts's parseActiveTab() shows/hides this on the exact same span as the
// side panel banner (SHOW right before it, HIDE in a finally covering every exit path —
// success, failure, or content-script-unreachable). Same message, distinct element: this is
// specifically about the parse step's "stay on this tab" constraint, not the Wellfound
// deepening/pagination flow's background-window overlay below.
function showParseOverlay(): void {
  createFullPageOverlay(PARSE_OVERLAY_HOST_ID, 'Parsing in progress — please stay on this page.', true);
}

function hideParseOverlay(): void {
  document.getElementById(PARSE_OVERLAY_HOST_ID)?.remove();
}

// Wellfound background-window "please don't close this" warning — Chrome gives an extension no
// way to block a window from being closed, so this can't prevent it, only make it obvious while
// the window is doing real work (see wellfound-background-window.ts for the closure-detection
// half of this feature). `label` names what's running ("deepening" / "pagination") so the copy
// is accurate for whichever flow opened the window. `progress` is a live running-count string
// (e.g. "Page 2/5 processed, 18 lead(s) found so far") the caller's own loop maintains — empty
// on the very first navigation, before anything's completed yet. No corresponding hide: every
// navigate() call is a real top-level navigation (see wellfound-background-window.ts), which
// wipes the previous page's DOM — overlay included — and the window is destroyed outright at
// the end of a run, so there's no point in the run where the overlay needs removing without a
// new one about to replace it or the whole tab going away.
// Label -> display text for the "don't close this window" overlay message. 'pagination' and
// 'deepening' are WellfoundBackgroundWindow's own labels (unchanged); 'indeed-pagination' is
// IndeedBackgroundWindow's (indeed-pagination.ts) — a distinct label rather than reusing
// 'pagination', so this map (and any future site) can never collide.
const BACKGROUND_OVERLAY_LABELS: Record<string, string> = {
  pagination: 'Wellfound page parsing',
  deepening: 'Wellfound deepening',
  'indeed-pagination': 'Indeed page parsing',
  'indeed-deepening': 'Indeed deepening',
};

function showBackgroundOverlay(label: string, progress: string): void {
  const what = BACKGROUND_OVERLAY_LABELS[label] ?? 'Background parsing';
  const progressSuffix = progress ? ` (${progress})` : '';
  createFullPageOverlay(
    BACKGROUND_OVERLAY_HOST_ID,
    `${what} in progress${progressSuffix} — closing this window will interrupt it. Already-saved leads are kept.`,
    false,
  );
}

export default defineContentScript({
  matches: [
    'https://www.techjobs.ca/*',
    'https://www.itjobs.ca/*',
    'https://www.devitjobs.nl/*',
    'https://devitjobs.nl/*',
    'https://wellfound.com/*',
    // DI-2966: every Indeed hostname registered in PARSERS above, same list, kept in sync
    // manually (see that const's comment). Deliberately NOT secure.indeed.com (the sign-in wall
    // hostname, see indeed-pagination.ts's isIndeedSignInWall) or a `*.indeed.com` wildcard —
    // secure.indeed.com must stay unmatched so landing there is unambiguous instead of racing an
    // injected-but-irrelevant content script, and a wildcard would inject on locales PARSERS
    // above doesn't actually recognize (see that const's comment for why that alone isn't enough).
    'https://www.indeed.com/*',
    'https://indeed.com/*',
    'https://ca.indeed.com/*',
    'https://ua.indeed.com/*',
  ],
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'PARSE_LIST') {
        const parser = PARSERS[location.hostname];
        if (!parser) {
          sendResponse({ ok: false, error: `No parser registered for ${location.hostname}.` });
          return;
        }

        try {
          const leads = parser.parseList(document);
          // Indeed pagination follows the site's own "next page" link — see findIndeedNextPageUrl.
          const extra =
            parser === indeedParser
              ? { nextPageUrl: findIndeedNextPageUrl(document), totalJobCount: findIndeedTotalJobCount(document) }
              : {};
          sendResponse({ ok: true, leads, ...extra });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (message?.type === 'EXTRACT_WELLFOUND_DETAIL') {
        pollForWellfoundDetail().then(sendResponse);
        return true; // keep the message channel open for the async poll
      }

      if (message?.type === 'EXTRACT_INDEED_DETAIL') {
        pollForIndeedDetail().then(sendResponse);
        return true; // keep the message channel open for the async poll
      }

      if (message?.type === 'SHOW_PARSE_OVERLAY') {
        showParseOverlay();
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === 'HIDE_PARSE_OVERLAY') {
        hideParseOverlay();
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === 'SHOW_BACKGROUND_OVERLAY') {
        showBackgroundOverlay(
          typeof message.label === 'string' ? message.label : '',
          typeof message.progress === 'string' ? message.progress : '',
        );
        sendResponse({ ok: true });
        return;
      }

      return undefined;
    });
  },
});
