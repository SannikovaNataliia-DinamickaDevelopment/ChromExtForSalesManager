import { TechjobsListParser } from '../lib/parsers/techjobs';
import { DevitjobsListParser } from '../lib/parsers/devitjobs';
import type { SiteParser } from '../lib/types';

// NFR-14: parser adapters are isolated — the coordinator below only ever picks
// a parser by hostname, it never branches on site-specific parsing logic.
const PARSERS: Record<string, SiteParser> = {
  'www.techjobs.ca': new TechjobsListParser(),
  'www.devitjobs.nl': new DevitjobsListParser(),
  'devitjobs.nl': new DevitjobsListParser(),
};

export default defineContentScript({
  matches: ['https://www.techjobs.ca/*', 'https://www.devitjobs.nl/*', 'https://devitjobs.nl/*'],
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== 'PARSE_LIST') return;

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
    });
  },
});
