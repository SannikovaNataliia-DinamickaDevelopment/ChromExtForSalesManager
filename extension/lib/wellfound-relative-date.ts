// Approximates an absolute Kyiv-day date from Wellfound's list-page relative posted-time text
// ("4 days ago", "yesterday", "5 months ago" — see parsers/wellfound.ts's own comment on why
// the list never exposes an absolute date, only WellfoundListParser's `snapshot.posted_relative`).
// Used ONLY to decide whether a posting falls inside the manager's picked date range during
// automated multi-page parsing (wellfound-pagination.ts's runWellfoundAutoPagination) — never
// written to a lead's own `published_at` field, which stays null until the detail page's
// precise JSON-LD `datePosted` backfills it during deepening (unchanged, existing behavior).
//
// Deliberately approximate, not exact: "N months ago" in particular can be off by roughly two
// weeks either way, and "N days ago" by up to a day (unknown time-of-day). A parse-time range
// filter needs SOME signal to work at all here — Wellfound exposes nothing more precise on the
// list — so this trades precision for being able to filter during the scan itself, which is
// what "no separate staging table" requires. Unparseable/unrecognized text returns null;
// callers treat null as "can't tell — include it" (fail open), since silently discarding a
// possibly-relevant lead is the worse failure mode (an over-included lead is just a lead the
// manager sees and ignores; an under-included one is invisible and never recovered).

const UNIT_TO_DAYS: Record<string, number> = {
  hour: 0,
  hours: 0,
  day: 1,
  days: 1,
  week: 7,
  weeks: 7,
  month: 30,
  months: 30,
  year: 365,
  years: 365,
};

function ymdToUtcMidnight(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMidnightToYmd(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// `todayIso` is the Kyiv-day "today" (YYYY-MM-DD) the caller anchors "N ago" against — passed
// in rather than computed here so a single run holds one fixed "today" throughout (see
// runWellfoundAutoPagination's own comment on why re-deriving it per-page would be overkill).
export function parseWellfoundRelativePosted(text: string | undefined | null, todayIso: string): string | null {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  if (t === 'today' || t.includes('just now')) return todayIso;
  if (t === 'yesterday') return utcMidnightToYmd(ymdToUtcMidnight(todayIso) - 86400000);

  // "a"/"an" as a singular-count synonym for "1" ("an hour ago", "a day ago") — Wellfound's own
  // examples in CLAUDE.md are all plural-count ("4 days ago"), but a singular form is a
  // near-certain phrasing this site (or a future markup tweak) uses too.
  const m = /^(\d+|a|an)\s+(hour|hours|day|days|week|weeks|month|months|year|years)\s+ago$/.exec(t);
  if (!m) return null;

  const n = m[1] === 'a' || m[1] === 'an' ? 1 : parseInt(m[1], 10);
  const unit = m[2];
  const days = unit.startsWith('hour') ? 0 : n * UNIT_TO_DAYS[unit];
  return utcMidnightToYmd(ymdToUtcMidnight(todayIso) - days * 86400000);
}

// Inclusive both ends — same convention as the dashboard's Published/Scraped date-range filters
// and wellfound-pagination-bookmark.ts's Kyiv-day comparisons. Plain string comparison is valid
// here because both sides are always YYYY-MM-DD (lexicographic order == chronological order).
export function isWithinRange(dateIso: string, start: string, end: string): boolean {
  return dateIso >= start && dateIso <= end;
}
