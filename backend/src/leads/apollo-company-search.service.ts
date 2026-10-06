import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/app-error';

// Company lookup by NAME in Apollo (06.10 call, point 5): Indeed gives a company name but no
// website, and the existing DM search (apollo-classifier.service.ts) needs a domain/organization
// id. This returns Apollo's candidate organizations for a name; the manager picks the right one
// in the dashboard (LeadsService.applyCompanyMatch saves its website + organization id).
//
// Apollo Organization Search — POST /mixed_companies/search with `q_organization_name` (partial
// matches accepted). Per Apollo's docs it costs 1 credit PER PAGE of results, so: one page of
// SEARCH_PER_PAGE, only on an explicit click, and an in-memory cache so repeating a name is free.
//
// Confirmed against a live response (06.10, "EPAM Systems"): this search returns NO location,
// employee count or industry (those need organizations/enrich — another credit per company);
// what it does return and is shown to tell the real company from namesakes/subsidiaries:
// website/primary_domain, linkedin_url, logo_url, founded_year, organization_revenue_printed,
// publicly_traded_symbol/exchange, owned_by_organization_id. location/employees/industry are
// still mapped in case an account-type result carries them. APOLLO_COMPANY_SEARCH_MOCK=true
// serves clearly-marked sample candidates instead, so the flow can be tried without credits.

const API_BASE = 'https://api.apollo.io/api/v1';
const ORG_SEARCH_PATH = '/mixed_companies/search';
const SEARCH_PER_PAGE = 10;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ApolloCompanyCandidate {
  id: string;
  name: string;
  website: string | null;
  domain: string | null;
  linkedinUrl: string | null;
  logoUrl: string | null;
  location: string | null;
  employees: number | null;
  industry: string | null;
  foundedYear: number | null;
  // e.g. "5.5B" — Apollo's own formatted annual revenue.
  revenue: string | null;
  // e.g. "NASDAQ: EPAM" for a publicly traded company.
  publicListing: string | null;
  // Apollo records this organization as owned by another one (a subsidiary / acquired brand).
  isSubsidiary: boolean;
}

export interface ApolloCompanySearchResult {
  query: string;
  candidates: ApolloCompanyCandidate[];
  // 'mock' = sample data from APOLLO_COMPANY_SEARCH_MOCK, never real Apollo results.
  source: 'apollo' | 'mock';
  // Served from the in-memory cache — no credit spent.
  cached: boolean;
  totalEntries: number | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function domainOf(website: string | null, primaryDomain: string | null): string | null {
  if (primaryDomain) return primaryDomain.toLowerCase().replace(/^www\./, '');
  if (!website) return null;
  try {
    return new URL(website.includes('://') ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function toCandidate(raw: unknown): ApolloCompanyCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id) ?? str(o.organization_id);
  const name = str(o.name);
  if (!id || !name) return null;
  const website = str(o.website_url);
  const domain = domainOf(website, str(o.primary_domain));
  const location = [str(o.city), str(o.state), str(o.country)].filter(Boolean).join(', ') || str(o.raw_address);
  const symbol = str(o.publicly_traded_symbol);
  const exchange = str(o.publicly_traded_exchange);
  return {
    id,
    name,
    website: domain ? `https://${domain}` : website,
    domain,
    linkedinUrl: str(o.linkedin_url),
    logoUrl: str(o.logo_url),
    location: location || null,
    employees: num(o.estimated_num_employees),
    industry: str(o.industry),
    foundedYear: num(o.founded_year),
    revenue: str(o.organization_revenue_printed),
    // exchange alone is not enough — Apollo filled "nasdaq" with no symbol on a namesake (live).
    publicListing: symbol ? `${exchange ? exchange.toUpperCase() + ': ' : ''}${symbol}` : null,
    isSubsidiary: !!str(o.owned_by_organization_id),
  };
}

function slug(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 30) || 'company';
}

// Sample candidates for APOLLO_COMPANY_SEARCH_MOCK — deliberately varied (an exact-looking match,
// a similarly named group, an unrelated namesake, one without a website) to exercise every UI state.
function mockCandidates(query: string): ApolloCompanyCandidate[] {
  const s = slug(query);
  return [
    {
      id: `mock-${s}-1`, name: query, website: `https://${s}.com`, domain: `${s}.com`,
      linkedinUrl: `https://www.linkedin.com/company/${s}`, logoUrl: null, location: 'Austin, Texas, United States',
      employees: 1200, industry: 'information technology & services', foundedYear: 2004,
      revenue: '120M', publicListing: null, isSubsidiary: false,
    },
    {
      id: `mock-${s}-2`, name: `${query} Group`, website: `https://${s}group.com`, domain: `${s}group.com`,
      linkedinUrl: null, logoUrl: null, location: 'London, England, United Kingdom',
      employees: 85, industry: 'management consulting', foundedYear: 2016,
      revenue: '8M', publicListing: null, isSubsidiary: true,
    },
    {
      id: `mock-${s}-3`, name: `${query} Bakery`, website: `https://${s}bakery.co`, domain: `${s}bakery.co`,
      linkedinUrl: null, logoUrl: null, location: 'Lyon, France', employees: 12, industry: 'food production', foundedYear: 1998,
      revenue: null, publicListing: null, isSubsidiary: false,
    },
    {
      id: `mock-${s}-4`, name: `${query} Holdings`, website: null, domain: null,
      linkedinUrl: null, logoUrl: null, location: null, employees: null, industry: null, foundedYear: null,
      revenue: null, publicListing: null, isSubsidiary: false,
    },
  ];
}

@Injectable()
export class ApolloCompanySearchService {
  private readonly logger = new Logger(ApolloCompanySearchService.name);
  private readonly cache = new Map<string, { at: number; result: ApolloCompanySearchResult }>();

  async searchByName(rawQuery: string): Promise<ApolloCompanySearchResult> {
    const query = rawQuery.trim().replace(/\s+/g, ' ');
    if (!query) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'EMPTY_QUERY', 'Enter a company name to search for.');
    }

    if (process.env.APOLLO_COMPANY_SEARCH_MOCK === 'true') {
      return { query, candidates: mockCandidates(query), source: 'mock', cached: false, totalEntries: 4 };
    }

    const apiKey = process.env.APOLLO_API_KEY;
    if (!apiKey) {
      throw new AppError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'APOLLO_NOT_CONFIGURED',
        'Apollo is not connected yet: APOLLO_API_KEY is missing in backend/.env. ' +
          '(To try this window with sample data, set APOLLO_COMPANY_SEARCH_MOCK=true.)',
      );
    }

    const key = query.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ...hit.result, cached: true };
    }

    let data: unknown;
    let status = 0;
    try {
      const res = await fetch(`${API_BASE}${ORG_SEARCH_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ q_organization_name: query, page: 1, per_page: SEARCH_PER_PAGE }),
      });
      status = res.status;
      data = await res.json().catch(() => null);
    } catch (err) {
      throw new AppError(
        HttpStatus.BAD_GATEWAY,
        'APOLLO_REQUEST_FAILED',
        `Could not reach Apollo: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // First-integration visibility (same convention as apollo-classifier.service.ts) — remove
    // once a real response has confirmed the field mapping in toCandidate().
    this.logger.log(`[APOLLO DEBUG] company search "${query}" HTTP ${status}: ${JSON.stringify(data).slice(0, 3000)}`);

    if (status < 200 || status >= 300) {
      const errBody = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
      const message = str(errBody.error) ?? str(errBody.message) ?? `HTTP ${status}`;
      if (status === 429 || /credit|quota|limit/i.test(message)) {
        throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'APOLLO_QUOTA', `Apollo refused the search (credits or rate limit): ${message}`);
      }
      throw new AppError(HttpStatus.BAD_GATEWAY, 'APOLLO_ERROR', `Apollo search failed: ${message}`);
    }

    const body = (data ?? {}) as Record<string, unknown>;
    // mixed_companies/search returns matches in `organizations` and, for companies already saved
    // in the Apollo account, `accounts` — merged, de-duplicated by id.
    const rawList = [
      ...(Array.isArray(body.accounts) ? body.accounts : []),
      ...(Array.isArray(body.organizations) ? body.organizations : []),
    ];
    const seen = new Set<string>();
    const candidates: ApolloCompanyCandidate[] = [];
    for (const raw of rawList) {
      const c = toCandidate(raw);
      if (c && !seen.has(c.id)) {
        seen.add(c.id);
        candidates.push(c);
      }
    }
    const pagination = body.pagination as Record<string, unknown> | undefined;
    const result: ApolloCompanySearchResult = {
      query,
      candidates,
      source: 'apollo',
      cached: false,
      totalEntries: num(pagination?.total_entries),
    };
    this.cache.set(key, { at: Date.now(), result });
    return result;
  }
}
