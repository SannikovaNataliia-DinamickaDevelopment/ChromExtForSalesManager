import { TechjobsListParser } from '../lib/parsers/techjobs';

export default defineContentScript({
  matches: ['https://www.techjobs.ca/*'],
  main() {
    const parser = new TechjobsListParser();

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== 'PARSE_LIST') return;

      try {
        const leads = parser.parseList(document);
        sendResponse({ ok: true, leads });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  },
});
