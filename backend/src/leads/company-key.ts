// "Same company" across leads (09.10): the company name without letter case, accents,
// punctuation and a trailing legal form — "EPAM Systems, Inc." and "EPAM Systems" are one company.
// Same rule as the dashboard's cleanCompanyQuery (Apollo search box), so what the manager sees
// grouped there is what the backend groups too.
const LEGAL_FORM_RE =
  /[,.]?\s*\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|ag|plc|pty|pvt|private|llp|lp|s\.?\s*de\s*r\.?\s*l\.?(\s*de\s*c\.?v\.?)?|s\.?a\.?(\s*de\s*c\.?v\.?)?|s\.?a\.?s|s\.?r\.?l|s\.?l|b\.?v|n\.?v|spa|s\.?p\.?a)\b\.?\s*$/i;

export function companyKey(name: string | null | undefined): string {
  let q = (name ?? '').trim();
  for (let i = 0; i < 3; i++) {
    const next = q.replace(LEGAL_FORM_RE, '').replace(/[\s,.\-]+$/, '').trim();
    if (next === q || !next) break;
    q = next;
  }
  return q
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim();
}

// Country a lead's vacancy belongs to — decides whether decision-makers (DM) may be shared
// between leads of one company (09.10: a large company's country/regional leaders differ, so DM
// are shared only within the same country; company-level data is shared everywhere).
// Indeed: its country domain (www/bare = us, malaysia.indeed.com = my). Techjobs/ITjobs are
// Canadian boards, DevITjobs Dutch; anything else (Wellfound) is its own bucket.
export function leadCountry(sourceSite: string, sourceUrl: string): string {
  if (sourceSite === 'indeed') {
    try {
      const host = new URL(sourceUrl).hostname.toLowerCase();
      if (host === 'indeed.com' || host === 'www.indeed.com') return 'us';
      if (host === 'malaysia.indeed.com') return 'my';
      return host.split('.')[0];
    } catch {
      return 'indeed';
    }
  }
  if (sourceSite === 'techjobs' || sourceSite === 'itjobs') return 'ca';
  if (sourceSite === 'devitjobs') return 'nl';
  return sourceSite;
}
