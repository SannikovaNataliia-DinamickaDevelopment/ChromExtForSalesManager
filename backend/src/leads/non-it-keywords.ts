// Cheap pre-filter (CLAUDE.md scope C): obviously non-IT job titles are flagged locally, with
// no Gemini call at all — the single biggest lever against the free tier's tight per-minute
// quota. Deliberately conservative: only roles that are NEVER IT belong here. Deliberately
// excluded even though they're tempting: "server" (server engineer/administrator), "technician"
// (IT technician), "operator" (IT operations), "engineer" — anything that overlaps with a real
// tech title stays OFF this list and falls through to Gemini instead ("when in doubt, send to
// Gemini rather than mislabel").
//
// Easy to edit: one lowercase word/phrase per line, matched as a whole word/phrase against the
// job title (case-insensitive).
export const NON_IT_KEYWORDS = [
  'cook',
  'chef',
  'sous chef',
  'baker',
  'butcher',
  'dishwasher',
  'driver',
  'truck driver',
  'delivery driver',
  'labourer',
  'laborer',
  'cleaner',
  'housekeeping',
  'housekeeper',
  'janitor',
  'custodian',
  'attendant',
  'cashier',
  'waiter',
  'waitress',
  'bartender',
  'barista',
  'nurse',
  'security guard',
  'warehouse',
  'forklift',
  'mechanic',
  'electrician',
  'plumber',
  'welder',
  'carpenter',
  'roofer',
  'landscaper',
  'groundskeeper',
  'receptionist',
  'flagger',
  'crane operator',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KEYWORD_PATTERN = new RegExp(`\\b(${NON_IT_KEYWORDS.map(escapeRegExp).join('|')})\\b`, 'i');

export function isObviouslyNonIt(title: string): boolean {
  return KEYWORD_PATTERN.test(title);
}
