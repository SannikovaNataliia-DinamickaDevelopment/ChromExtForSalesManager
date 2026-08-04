import { TechjobsListParser } from '../lib/parsers/techjobs';
import { DevitjobsListParser } from '../lib/parsers/devitjobs';
import { WellfoundListParser } from '../lib/parsers/wellfound';
import { extractWellfoundJobPosting } from '../lib/wellfound-detail-extract';
import type { SiteParser } from '../lib/types';

// NFR-14: parser adapters are isolated — the coordinator below only ever picks
// a parser by hostname, it never branches on site-specific parsing logic.
// itjobs.ca is the same template as techjobs.ca (confirmed against spikes/itjobs_list.html
// and spikes/itjobs_detail.html — identical card markup and JSON-LD JobPosting shape), so it
// reuses TechjobsListParser with its own source_site/base_url instead of a new parser class.
const PARSERS: Record<string, SiteParser> = {
  'www.techjobs.ca': new TechjobsListParser('techjobs', 'https://www.techjobs.ca'),
  'www.itjobs.ca': new TechjobsListParser('itjobs', 'https://www.itjobs.ca'),
  'www.devitjobs.nl': new DevitjobsListParser(),
  'devitjobs.nl': new DevitjobsListParser(),
  'wellfound.com': new WellfoundListParser(),
};

// CLAUDE.md scope D (Wellfound deepening): how long to poll a detail page's DOM for the
// JSON-LD JobPosting before giving up. Not just tabs.onUpdated 'complete' — Next.js hydration
// can finish after network-idle, per the manager's own spec for this feature.
const WELLFOUND_POLL_INTERVAL_MS = 400;
const WELLFOUND_POLL_TIMEOUT_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Also covers a DataDome challenge page shown instead of the real job page: it never gets a
// JobPosting JSON-LD either, so it falls through to the same timeout/failure path — no
// separate challenge-page detection needed.
async function pollForWellfoundDetail() {
  const start = Date.now();
  while (Date.now() - start < WELLFOUND_POLL_TIMEOUT_MS) {
    const detail = extractWellfoundJobPosting(document);
    if (detail) return { ok: true as const, detail };
    await sleep(WELLFOUND_POLL_INTERVAL_MS);
  }
  return {
    ok: false as const,
    error: 'Timed out waiting for job posting data (15s) — possibly a bot-detection challenge page.',
  };
}

export default defineContentScript({
  matches: [
    'https://www.techjobs.ca/*',
    'https://www.itjobs.ca/*',
    'https://www.devitjobs.nl/*',
    'https://devitjobs.nl/*',
    'https://wellfound.com/*',
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
          sendResponse({ ok: true, leads });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (message?.type === 'EXTRACT_WELLFOUND_DETAIL') {
        pollForWellfoundDetail().then(sendResponse);
        return true; // keep the message channel open for the async poll
      }

      return undefined;
    });
  },
});
