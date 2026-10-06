// Single source of truth for Indeed's country domains (02.10, multi-region parsing). Replaces the
// hand-synced hostname lists that used to live in content.ts (PARSERS + matches), wxt.config.ts
// (host_permissions), backend.ts (SUPPORTED_HOSTS) and App.tsx (INDEED_HOSTNAMES): the manifest
// now matches `*.indeed.com` once, and everything else asks isIndeedHost()/INDEED_REGIONS here.
//
// Adding a country = one entry below. Before relying on a new one, run it once and check its page
// log: the list model (#mosaic-data) and `l=<remoteLocation>` behaviour are only confirmed live for
// ca.indeed.com so far (see indeed-pagination.ts).

export interface IndeedRegion {
  id: string;
  host: string;
  label: string;
  // IANA zone the picked date range is evaluated in for this region — a Kyiv calendar day starts
  // 7-10h before a North American one (confirmed 02.10: a posting from the evening of 10.09 in
  // Toronto was already 11.09 Kyiv), so judging every region by Kyiv time shifts the range edges.
  timeZone: string;
  // Value for Indeed's location param (`l`). The company hires remote-only (02.10 decision), so
  // every region searches its "Remote" location, whatever location the manager's own tab had.
  // UNVERIFIED for non-English domains (de.indeed.com may expect a localized term) — per-region
  // so a fix is a one-line change.
  remoteLocation: string;
}

export const INDEED_REGIONS: IndeedRegion[] = [
  { id: 'us', host: 'www.indeed.com', label: 'USA', timeZone: 'America/New_York', remoteLocation: 'Remote' },
  { id: 'ca', host: 'ca.indeed.com', label: 'Canada', timeZone: 'America/Toronto', remoteLocation: 'Remote' },
  { id: 'au', host: 'au.indeed.com', label: 'Australia', timeZone: 'Australia/Sydney', remoteLocation: 'Remote' },
  { id: 'uk', host: 'uk.indeed.com', label: 'United Kingdom', timeZone: 'Europe/London', remoteLocation: 'Remote' },
  { id: 'de', host: 'de.indeed.com', label: 'Germany', timeZone: 'Europe/Berlin', remoteLocation: 'Remote' },
];

// Indeed's account/sign-in host — never a job page (see indeed-pagination.ts's isIndeedSignInWall).
export const INDEED_SIGNIN_HOST = 'secure.indeed.com';

// Any Indeed job-site hostname (bare indeed.com, www, or a country subdomain — including ones not
// in INDEED_REGIONS, e.g. ua.indeed.com, which single-page "Parse current list page" still
// supports), excluding the sign-in host.
export function isIndeedHost(hostname: string): boolean {
  if (hostname === INDEED_SIGNIN_HOST) return false;
  return hostname === 'indeed.com' || hostname.endsWith('.indeed.com');
}

export function findIndeedRegionByHost(hostname: string): IndeedRegion | undefined {
  const normalized = hostname === 'indeed.com' ? 'www.indeed.com' : hostname;
  return INDEED_REGIONS.find((r) => r.host === normalized);
}

// Region a saved lead belongs to, from its source_url's host (no separate DB column needed).
export function indeedRegionLabelForUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    return findIndeedRegionByHost(host)?.label ?? host;
  } catch {
    return '';
  }
}

// Calendar date (YYYY-MM-DD) of an instant in the given IANA zone — the per-region counterpart of
// format-time.ts's formatKyivDate, used for the date-range check and the "Date posted" bucket.
export function formatDateInZone(value: string | null | undefined, timeZone: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
