// Best-effort company website guess from a job description's free text (06.10 call, Indeed:
// Indeed exposes no company website, so the description is the only on-posting source). The
// result is a GUESS — stored with company_website_source = 'description_guess' and flagged in the
// dashboard / gated before Apollo (see schema.ts's companyWebsiteSourceEnum).
//
// Survey of 60 real Indeed descriptions (06.10): Indeed's sanitizedJobDescription keeps no <a>
// tags at all, so candidates mostly come from plain-text domains ("landmarkglobal.com", "Visit
// www.x.com") and contact e-mail domains ("careers@servicenow.com" → servicenow.com — only the
// domain is used, the address itself is never stored). Roughly 1 in 6 descriptions yields one.
// Traps seen in that sample, all handled below: tech names that look like domains (asp.net,
// ado.net), form/ATS/job-board links (jotform.com, trakstar.com), careers-only TLDs (amazon.jobs).

export interface WebsiteCandidate {
  domain: string;
  score: number;
  sources: string[];
  nameMatch: boolean;
}

export interface WebsiteGuess {
  website: string; // https://<registrable domain>
  domain: string;
  candidates: WebsiteCandidate[];
}

// Job boards, ATS/recruiting platforms, forms, social networks, link shorteners, free e-mail
// providers, compliance/government notices and tech-term "domains" — never a company's own site.
const BLOCKED_DOMAINS = new Set([
  'indeed.com', 'linkedin.com', 'glassdoor.com', 'ziprecruiter.com', 'monster.com', 'careerbuilder.com',
  'simplyhired.com', 'dice.com', 'wellfound.com', 'angel.co', 'builtin.com', 'hired.com', 'weworkremotely.com',
  'remoteok.com', 'remote.co', 'flexjobs.com', 'techjobs.ca', 'itjobs.ca', 'devitjobs.nl', 'computrabajo.com',
  'occ.com.mx', 'bumeran.com.mx', 'seek.com.au', 'stepstone.de', 'reed.co.uk', 'totaljobs.com',
  'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'workday.com', 'smartrecruiters.com', 'icims.com',
  'jobvite.com', 'bamboohr.com', 'ashbyhq.com', 'recruitee.com', 'breezy.hr', 'workable.com', 'teamtailor.com',
  'personio.de', 'personio.com', 'successfactors.com', 'successfactors.eu', 'taleo.net', 'oraclecloud.com',
  'adp.com', 'ultipro.com', 'ukg.com', 'paylocity.com', 'applytojob.com', 'jazzhr.com', 'dayforcehcm.com',
  'trakstar.com', 'hirebridge.com', 'paycomonline.net', 'rippling.com', 'gusto.com', 'pinpointhq.com',
  'jotform.com', 'typeform.com', 'forms.gle', 'surveymonkey.com', 'calendly.com',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'wa.me', 'whatsapp.com',
  'google.com', 'goo.gl', 'bit.ly', 't.co', 'tinyurl.com', 'lnkd.in', 'linktr.ee',
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com',
  'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.de', 'gmx.com', 'web.de', 'mail.ru', 'yandex.ru',
  'ukr.net', 'qq.com', '163.com',
  'e-verify.gov', 'eeoc.gov', 'dol.gov', 'uscis.gov', 'w3.org', 'schema.org', 'wikipedia.org', 'github.com',
  'medium.com', 'apple.com', 'play.google.com',
  'asp.net', 'ado.net', 'vb.net', 'node.js', 'vue.js', 'next.js', 'react.js',
]);

// TLDs that are never a company's main site (careers microsites, government notices).
const BLOCKED_TLDS = new Set(['jobs', 'gov', 'mil']);

// Second-level labels under which the registrable domain has three labels (example.co.uk).
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'com.mx', 'com.br', 'com.ar', 'com.co', 'com.pe',
  'com.tr', 'com.sg', 'com.hk', 'com.tw', 'com.cn', 'co.jp', 'co.kr', 'co.in', 'co.za', 'co.nz', 'co.id', 'com.my',
  'com.ph', 'com.pk', 'com.eg', 'com.sa', 'com.uy', 'com.ec', 'com.ve',
]);

// Common TLDs accepted for a bare domain in running text ("acme.com") — a bare token needs a
// recognizable TLD AND a company-name match (see guessCompanyWebsite).
const BARE_TLDS = 'com|io|ai|co|net|org|ca|mx|us|uk|de|fr|es|it|nl|be|ch|at|au|nz|br|ar|in|sg|tech|dev|app|cloud|software|digital';

const LEGAL_SUFFIX_WORDS = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh', 'ag', 'sa', 'sas',
  'srl', 'sl', 'bv', 'nv', 'plc', 'pty', 'pvt', 'private', 'lp', 'llp', 'de', 'cv', 'rl', 'the', 'and', 'group',
  'holdings', 'international', 'global', 'services', 'solutions',
]);

export function registrableDomain(host: string): string | null {
  const h = host.toLowerCase().replace(/^\.+|\.+$/g, '');
  const labels = h.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_LEVEL_SUFFIXES.has(lastTwo)) return labels.length >= 3 ? labels.slice(-3).join('.') : null;
  return lastTwo;
}

export function isBlocked(domain: string): boolean {
  if (BLOCKED_DOMAINS.has(domain)) return true;
  const tld = domain.split('.').pop() ?? '';
  return BLOCKED_TLDS.has(tld);
}

export function nameTokens(company: string): string[] {
  const plain = company
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.(com|ca|io|ai|net|org)\b/g, ' ');
  return plain
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !LEGAL_SUFFIX_WORDS.has(t));
}

// 0 = no match, 2 = the domain's main label contains a name token / the name contains the label,
// 3 = the label starts with the name (wabteccorp.com for "Wabtec" beats mywabtecbenefits.com).
export function nameMatchScore(domain: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const label = domain.split('.')[0].replace(/-/g, '');
  const joined = tokens.join('');
  if (label.startsWith(tokens[0]) || joined.startsWith(label)) return 3;
  if (tokens.some((t) => label.includes(t)) || (label.length >= 4 && joined.includes(label))) return 2;
  return 0;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#64;|&commat;/g, '@');
}

export function guessCompanyWebsite(description: string | null | undefined, company: string | null | undefined): WebsiteGuess | null {
  if (!description) return null;
  const tokens = nameTokens(company ?? '');
  const found = new Map<string, { hits: number; sources: Set<string>; explicit: boolean }>();
  const add = (host: string, source: string, explicit: boolean) => {
    const domain = registrableDomain(host);
    if (!domain || isBlocked(domain)) return;
    const entry = found.get(domain) ?? { hits: 0, sources: new Set<string>(), explicit: false };
    entry.hits++;
    entry.sources.add(source);
    entry.explicit = entry.explicit || explicit;
    found.set(domain, entry);
  };

  // Real links (rare on Indeed, but other sources keep them).
  for (const m of description.matchAll(/href\s*=\s*["']https?:\/\/([^/"'?#:\s]+)/gi)) add(m[1], 'link', true);

  const text = stripHtml(description);
  // Explicit URLs / www. addresses in text.
  for (const m of text.matchAll(/(?:https?:\/\/|\bwww\.)([a-z0-9.-]+\.[a-z]{2,})/gi)) add(m[1], 'url', true);
  // E-mail domains — the address itself is discarded (no contact data is kept).
  for (const m of text.matchAll(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi)) add(m[1], 'email', false);
  // Bare domains in running text.
  const bare = new RegExp(`\\b([a-z0-9][a-z0-9-]{1,40}(?:\\.[a-z0-9-]{1,40})?\\.(?:${BARE_TLDS}))\\b`, 'gi');
  for (const m of text.matchAll(bare)) add(m[1], 'text', false);

  const candidates: WebsiteCandidate[] = [...found.entries()].map(([domain, e]) => {
    const match = nameMatchScore(domain, tokens);
    return {
      domain,
      nameMatch: match > 0,
      score: match * 10 + (e.explicit ? 3 : 0) + Math.min(e.hits, 5),
      sources: [...e.sources],
    };
  });
  candidates.sort((a, b) => b.score - a.score);

  // Accept the top candidate only if it matches the company name, or it is the single explicit
  // URL/link in the whole description (an unrelated bare token or e-mail domain alone isn't enough).
  const best = candidates[0];
  if (!best) return null;
  const explicitOnes = candidates.filter((c) => found.get(c.domain)?.explicit);
  const accepted = best.nameMatch || (explicitOnes.length === 1 && explicitOnes[0] === best);
  if (!accepted) return null;

  return { website: `https://${best.domain}`, domain: best.domain, candidates };
}
