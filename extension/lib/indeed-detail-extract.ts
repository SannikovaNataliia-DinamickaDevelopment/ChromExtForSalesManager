import type { DeepenedFields } from './deepening-strategy';
import { extractBalancedJson } from './parsers/indeed';

// DI-2966 follow-up (24.09): Indeed's detail page (viewjob?jk=...) embeds the same client-side
// model the page's own React app hydrates from in a <script> tag. The obvious-looking
// `window._initialData = {...}` assignment is NOT usable for this: one of its properties is
// `viewJobClientSideModel: window._rootProps.preloadedVJData` — a live JS variable REFERENCE,
// not an inline literal, so the object as a whole isn't valid standalone JSON no matter how
// carefully it's brace-matched (confirmed live — this was the actual reason extraction timed
// out every time, not a polling/timing problem).
//
// The fix, also confirmed live against a real job page: the SAME script tag separately contains
// `"preloadedVJData":{...}` earlier in its text, and that nested object IS genuine, complete,
// valid inline JSON (`{"accountKey":"9a0dbf57",...}`) — the live variable reference above points
// at a copy of the exact same data this literal already holds. Reading `preloadedVJData` directly
// needs no `.viewJobClientSideModel` wrapper — confirmed live that
// `preloadedVJData.jobInfoWrapperModel.jobInfoModel.sanitizedJobDescription` is the correct path
// (length 2690 for a real job).
//
// Same "read the embedded JSON via a <script> tag's raw text, never window.X at runtime" approach
// already used for the list page (parsers/indeed.ts) — a content script's isolated JS world
// cannot see a MAIN-world `window` property at all; only the DOM, including a <script> tag's own
// textContent, crosses that boundary. A real tab navigation (indeed-deepen.ts's
// IndeedTabDeepening) runs the page's own scripts, which is what actually populates this script
// tag's content; a plain fetch() never would have, independent of the _initialData/preloadedVJData
// distinction above.
const PRELOADED_VJ_DATA_MARKER = '"preloadedVJData":';

function findPreloadedVjData(doc: Document): unknown | null {
  const scripts = Array.from(doc.querySelectorAll('script'));

  for (const script of scripts) {
    const text = script.textContent;
    if (!text || !text.includes(PRELOADED_VJ_DATA_MARKER)) continue;

    const markerIndex = text.indexOf(PRELOADED_VJ_DATA_MARKER);
    const braceIndex = text.indexOf('{', markerIndex + PRELOADED_VJ_DATA_MARKER.length);
    if (braceIndex === -1) continue;

    const jsonText = extractBalancedJson(text, braceIndex);
    if (!jsonText) continue;

    try {
      return JSON.parse(jsonText);
    } catch {
      // Marker matched but the object that followed didn't parse as JSON — could be a false
      // positive (the marker string appearing somewhere unrelated in this particular script) or
      // a genuinely non-JSON JS object literal. Either way, try the next script tag rather than
      // giving up on the whole page.
      continue;
    }
  }

  return null;
}

// Confirmed request from this task: only `description` is ever populated here.
// company/company_website/published_at are deliberately left blank/null — those fields are
// already set (or not) from the list parse and must stay untouched. indeed-deepen.ts's
// deepenIndeedLeads sends ONLY `description` to the backend PATCH, never spreading these
// placeholder values in, so their exact value here doesn't matter beyond satisfying
// DeepenedFields' required shape.
export function extractIndeedJobDescription(doc: Document): DeepenedFields | null {
  const data = findPreloadedVjData(doc);
  if (!data || typeof data !== 'object') return null;

  const description = (
    data as {
      jobInfoWrapperModel?: {
        jobInfoModel?: {
          sanitizedJobDescription?: unknown;
        };
      };
    }
  )?.jobInfoWrapperModel?.jobInfoModel?.sanitizedJobDescription;

  if (typeof description !== 'string' || !description) return null;

  return {
    description,
    company: '',
    company_website: '',
    published_at: null,
  };
}
