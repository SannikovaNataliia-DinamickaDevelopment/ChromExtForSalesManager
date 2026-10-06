// Single source of truth for Indeed's country domains (02.10, multi-region parsing). Replaces the
// hand-synced hostname lists that used to live in content.ts (PARSERS + matches), wxt.config.ts
// (host_permissions), backend.ts (SUPPORTED_HOSTS) and App.tsx (INDEED_HOSTNAMES): the manifest
// now matches `*.indeed.com` once, and everything else asks isIndeedHost()/INDEED_REGIONS here.
//
// Adding a country = one entry below. Check a new one's page log after its first run: the list
// model (#mosaic-data) and `l=<remoteLocation>` behaviour vary by domain (see the survey note on
// INDEED_REGIONS).

export type IndeedRegionGroup = 'Americas' | 'Europe' | 'Asia-Pacific' | 'Middle East & Africa';

export interface IndeedRegion {
  id: string;
  host: string;
  label: string;
  // Part of the world — groups the side panel's region dropdown.
  group: IndeedRegionGroup;
  // IANA zone the picked date range is evaluated in for this region — a Kyiv calendar day starts
  // 7-10h before a North American one (confirmed 02.10: a posting from the evening of 10.09 in
  // Toronto was already 11.09 Kyiv), so judging every region by Kyiv time shifts the range edges.
  // Multi-zone countries use their main business zone.
  timeZone: string;
  // Value for Indeed's location param (`l`). The company hires remote-only (02.10 decision), so
  // every region searches its "Remote" location, whatever location the manager's own tab had.
  // Survey 06.10: most domains map "Remote" to their own remote location ("Home Office",
  // "Desde casa", "etätyö", ...); some don't recognize it and return the whole country instead
  // (cn, cl, eg, dk, jp seen so far) — per-region so a localized term is a one-line change.
  remoteLocation: string;
}

export const INDEED_REGION_GROUPS: IndeedRegionGroup[] = ['Americas', 'Europe', 'Asia-Pacific', 'Middle East & Africa'];

// Every country Indeed lists on its own country selector (indeed.com/worldwide, read 06.10 — 62
// domains). There is NO cross-country domain: www.indeed.com is the US only (an unrecognized
// location like "Worldwide" falls back to the whole US). Malaysia's host is malaysia.indeed.com,
// not my.indeed.com.
//
// Survey 06.10 (q=software engineer, l=Remote, last 7 days) confirmed the usual list model on
// ar, au, at, bh, be, br, ca, cl, cn, co, cr, cz, dk, ec, eg, fi, de, gr, hk, hu, jp, us.
// fr.indeed.com rendered WITHOUT #mosaic-data (different page structure — not parseable yet).
// The survey stopped at a Cloudflare check on in/id/ie/il/it; the rest are unverified.
export const INDEED_REGIONS: IndeedRegion[] = [
  { id: 'us', host: 'www.indeed.com', label: 'United States', group: 'Americas', timeZone: 'America/New_York', remoteLocation: 'Remote' },
  { id: 'ca', host: 'ca.indeed.com', label: 'Canada', group: 'Americas', timeZone: 'America/Toronto', remoteLocation: 'Remote' },
  { id: 'ar', host: 'ar.indeed.com', label: 'Argentina', group: 'Americas', timeZone: 'America/Argentina/Buenos_Aires', remoteLocation: 'Remote' },
  { id: 'br', host: 'br.indeed.com', label: 'Brazil', group: 'Americas', timeZone: 'America/Sao_Paulo', remoteLocation: 'Remote' },
  { id: 'cl', host: 'cl.indeed.com', label: 'Chile', group: 'Americas', timeZone: 'America/Santiago', remoteLocation: 'Remote' },
  { id: 'co', host: 'co.indeed.com', label: 'Colombia', group: 'Americas', timeZone: 'America/Bogota', remoteLocation: 'Remote' },
  { id: 'cr', host: 'cr.indeed.com', label: 'Costa Rica', group: 'Americas', timeZone: 'America/Costa_Rica', remoteLocation: 'Remote' },
  { id: 'ec', host: 'ec.indeed.com', label: 'Ecuador', group: 'Americas', timeZone: 'America/Guayaquil', remoteLocation: 'Remote' },
  { id: 'mx', host: 'mx.indeed.com', label: 'Mexico', group: 'Americas', timeZone: 'America/Mexico_City', remoteLocation: 'Remote' },
  { id: 'pa', host: 'pa.indeed.com', label: 'Panama', group: 'Americas', timeZone: 'America/Panama', remoteLocation: 'Remote' },
  { id: 'pe', host: 'pe.indeed.com', label: 'Peru', group: 'Americas', timeZone: 'America/Lima', remoteLocation: 'Remote' },
  { id: 'uy', host: 'uy.indeed.com', label: 'Uruguay', group: 'Americas', timeZone: 'America/Montevideo', remoteLocation: 'Remote' },
  { id: 've', host: 've.indeed.com', label: 'Venezuela', group: 'Americas', timeZone: 'America/Caracas', remoteLocation: 'Remote' },
  { id: 'uk', host: 'uk.indeed.com', label: 'United Kingdom', group: 'Europe', timeZone: 'Europe/London', remoteLocation: 'Remote' },
  { id: 'ie', host: 'ie.indeed.com', label: 'Ireland', group: 'Europe', timeZone: 'Europe/Dublin', remoteLocation: 'Remote' },
  { id: 'de', host: 'de.indeed.com', label: 'Germany', group: 'Europe', timeZone: 'Europe/Berlin', remoteLocation: 'Remote' },
  { id: 'at', host: 'at.indeed.com', label: 'Austria', group: 'Europe', timeZone: 'Europe/Vienna', remoteLocation: 'Remote' },
  { id: 'ch', host: 'ch.indeed.com', label: 'Switzerland', group: 'Europe', timeZone: 'Europe/Zurich', remoteLocation: 'Remote' },
  { id: 'nl', host: 'nl.indeed.com', label: 'Netherlands', group: 'Europe', timeZone: 'Europe/Amsterdam', remoteLocation: 'Remote' },
  { id: 'be', host: 'be.indeed.com', label: 'Belgium', group: 'Europe', timeZone: 'Europe/Brussels', remoteLocation: 'Remote' },
  { id: 'lu', host: 'lu.indeed.com', label: 'Luxembourg', group: 'Europe', timeZone: 'Europe/Luxembourg', remoteLocation: 'Remote' },
  { id: 'fr', host: 'fr.indeed.com', label: 'France', group: 'Europe', timeZone: 'Europe/Paris', remoteLocation: 'Remote' },
  { id: 'es', host: 'es.indeed.com', label: 'Spain', group: 'Europe', timeZone: 'Europe/Madrid', remoteLocation: 'Remote' },
  { id: 'pt', host: 'pt.indeed.com', label: 'Portugal', group: 'Europe', timeZone: 'Europe/Lisbon', remoteLocation: 'Remote' },
  { id: 'it', host: 'it.indeed.com', label: 'Italy', group: 'Europe', timeZone: 'Europe/Rome', remoteLocation: 'Remote' },
  { id: 'pl', host: 'pl.indeed.com', label: 'Poland', group: 'Europe', timeZone: 'Europe/Warsaw', remoteLocation: 'Remote' },
  { id: 'cz', host: 'cz.indeed.com', label: 'Czech Republic', group: 'Europe', timeZone: 'Europe/Prague', remoteLocation: 'Remote' },
  { id: 'hu', host: 'hu.indeed.com', label: 'Hungary', group: 'Europe', timeZone: 'Europe/Budapest', remoteLocation: 'Remote' },
  { id: 'ro', host: 'ro.indeed.com', label: 'Romania', group: 'Europe', timeZone: 'Europe/Bucharest', remoteLocation: 'Remote' },
  { id: 'gr', host: 'gr.indeed.com', label: 'Greece', group: 'Europe', timeZone: 'Europe/Athens', remoteLocation: 'Remote' },
  { id: 'se', host: 'se.indeed.com', label: 'Sweden', group: 'Europe', timeZone: 'Europe/Stockholm', remoteLocation: 'Remote' },
  { id: 'dk', host: 'dk.indeed.com', label: 'Denmark', group: 'Europe', timeZone: 'Europe/Copenhagen', remoteLocation: 'Remote' },
  { id: 'no', host: 'no.indeed.com', label: 'Norway', group: 'Europe', timeZone: 'Europe/Oslo', remoteLocation: 'Remote' },
  { id: 'fi', host: 'fi.indeed.com', label: 'Finland', group: 'Europe', timeZone: 'Europe/Helsinki', remoteLocation: 'Remote' },
  { id: 'ua', host: 'ua.indeed.com', label: 'Ukraine', group: 'Europe', timeZone: 'Europe/Kyiv', remoteLocation: 'Remote' },
  { id: 'tr', host: 'tr.indeed.com', label: 'Turkey', group: 'Europe', timeZone: 'Europe/Istanbul', remoteLocation: 'Remote' },
  { id: 'au', host: 'au.indeed.com', label: 'Australia', group: 'Asia-Pacific', timeZone: 'Australia/Sydney', remoteLocation: 'Remote' },
  { id: 'nz', host: 'nz.indeed.com', label: 'New Zealand', group: 'Asia-Pacific', timeZone: 'Pacific/Auckland', remoteLocation: 'Remote' },
  { id: 'sg', host: 'sg.indeed.com', label: 'Singapore', group: 'Asia-Pacific', timeZone: 'Asia/Singapore', remoteLocation: 'Remote' },
  { id: 'hk', host: 'hk.indeed.com', label: 'Hong Kong', group: 'Asia-Pacific', timeZone: 'Asia/Hong_Kong', remoteLocation: 'Remote' },
  { id: 'in', host: 'in.indeed.com', label: 'India', group: 'Asia-Pacific', timeZone: 'Asia/Kolkata', remoteLocation: 'Remote' },
  { id: 'pk', host: 'pk.indeed.com', label: 'Pakistan', group: 'Asia-Pacific', timeZone: 'Asia/Karachi', remoteLocation: 'Remote' },
  { id: 'ph', host: 'ph.indeed.com', label: 'Philippines', group: 'Asia-Pacific', timeZone: 'Asia/Manila', remoteLocation: 'Remote' },
  { id: 'my', host: 'malaysia.indeed.com', label: 'Malaysia', group: 'Asia-Pacific', timeZone: 'Asia/Kuala_Lumpur', remoteLocation: 'Remote' },
  { id: 'id', host: 'id.indeed.com', label: 'Indonesia', group: 'Asia-Pacific', timeZone: 'Asia/Jakarta', remoteLocation: 'Remote' },
  { id: 'th', host: 'th.indeed.com', label: 'Thailand', group: 'Asia-Pacific', timeZone: 'Asia/Bangkok', remoteLocation: 'Remote' },
  { id: 'vn', host: 'vn.indeed.com', label: 'Vietnam', group: 'Asia-Pacific', timeZone: 'Asia/Ho_Chi_Minh', remoteLocation: 'Remote' },
  { id: 'jp', host: 'jp.indeed.com', label: 'Japan', group: 'Asia-Pacific', timeZone: 'Asia/Tokyo', remoteLocation: 'Remote' },
  { id: 'kr', host: 'kr.indeed.com', label: 'South Korea', group: 'Asia-Pacific', timeZone: 'Asia/Seoul', remoteLocation: 'Remote' },
  { id: 'tw', host: 'tw.indeed.com', label: 'Taiwan', group: 'Asia-Pacific', timeZone: 'Asia/Taipei', remoteLocation: 'Remote' },
  { id: 'cn', host: 'cn.indeed.com', label: 'China', group: 'Asia-Pacific', timeZone: 'Asia/Shanghai', remoteLocation: 'Remote' },
  { id: 'ae', host: 'ae.indeed.com', label: 'United Arab Emirates', group: 'Middle East & Africa', timeZone: 'Asia/Dubai', remoteLocation: 'Remote' },
  { id: 'sa', host: 'sa.indeed.com', label: 'Saudi Arabia', group: 'Middle East & Africa', timeZone: 'Asia/Riyadh', remoteLocation: 'Remote' },
  { id: 'qa', host: 'qa.indeed.com', label: 'Qatar', group: 'Middle East & Africa', timeZone: 'Asia/Qatar', remoteLocation: 'Remote' },
  { id: 'kw', host: 'kw.indeed.com', label: 'Kuwait', group: 'Middle East & Africa', timeZone: 'Asia/Kuwait', remoteLocation: 'Remote' },
  { id: 'bh', host: 'bh.indeed.com', label: 'Bahrain', group: 'Middle East & Africa', timeZone: 'Asia/Bahrain', remoteLocation: 'Remote' },
  { id: 'om', host: 'om.indeed.com', label: 'Oman', group: 'Middle East & Africa', timeZone: 'Asia/Muscat', remoteLocation: 'Remote' },
  { id: 'il', host: 'il.indeed.com', label: 'Israel', group: 'Middle East & Africa', timeZone: 'Asia/Jerusalem', remoteLocation: 'Remote' },
  { id: 'eg', host: 'eg.indeed.com', label: 'Egypt', group: 'Middle East & Africa', timeZone: 'Africa/Cairo', remoteLocation: 'Remote' },
  { id: 'ma', host: 'ma.indeed.com', label: 'Morocco', group: 'Middle East & Africa', timeZone: 'Africa/Casablanca', remoteLocation: 'Remote' },
  { id: 'ng', host: 'ng.indeed.com', label: 'Nigeria', group: 'Middle East & Africa', timeZone: 'Africa/Lagos', remoteLocation: 'Remote' },
  { id: 'za', host: 'za.indeed.com', label: 'South Africa', group: 'Middle East & Africa', timeZone: 'Africa/Johannesburg', remoteLocation: 'Remote' },
];

// Pre-selected in the side panel's region dropdown until the manager changes the selection
// (then her own choice is remembered — see App.tsx).
export const DEFAULT_INDEED_REGION_IDS = ['us', 'ca', 'au', 'uk', 'de'];

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
