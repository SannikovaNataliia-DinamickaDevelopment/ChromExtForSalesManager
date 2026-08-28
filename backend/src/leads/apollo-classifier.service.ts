import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, inArray, isNotNull, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { job_leads } from '../db/schema';
import { extractDomain, FINAL_PEOPLE_CAP, ROLE_PRIORITY_ORDER, roleSortIndex } from './openai-classifier.service';
import { LPR_ROLES, type LprPerson, type LprSearchResult } from './gemini-classifier.service';

const API_BASE = 'https://api.apollo.io/api/v1';
// Per Apollo's own official docs (26.08 follow-up) — two calls, deliberately in this order:
// 1. mixed_people/api_search: free (0 credits), searches by person_titles + company domain,
//    returns obfuscated names + an internal Apollo person id per candidate — not usable to
//    display, just enough to know WHO to look up next.
// 2. people/bulk_match: the only call that costs credits (~1/person with reveal flags off,
//    +8 for phone — we never reveal phone/email, we don't need them and it's strictly more
//    expensive), takes the ids from step 1 and returns full name + linkedin_url + title.
const SEARCH_PATH = '/mixed_people/api_search';
const BULK_MATCH_PATH = '/people/bulk_match';
// 28.08 follow-up — GET, not POST (confirmed against docs.apollo.io/reference/
// organization-enrichment, not guessed). Costs 1 credit per call (also per those docs); resolved
// once per company and cached (see the apollo_organization_id column comment in schema.ts and
// resolveOrganizationId's own comment below) specifically to keep this rare, not per-search.
const ORG_ENRICH_PATH = '/organizations/enrich';

// 26.08 follow-up: this is Apollo's own documented HARD LIMIT for a single bulk_match request
// ("cannot enrich more than 10 in a single request"), not a tunable sanity ceiling like OpenAI's
// PHASE2_CANDIDATE_CAP (openai-classifier.service.ts) — a request for more than 10 would simply
// fail. Originally guessed at 15 before this was confirmed against Apollo's own API error;
// corrected to 10. Still comfortably above FINAL_PEOPLE_CAP (8), so the final priority-sorted cap
// below still has real headroom to choose from. No batching/chunking across multiple bulk_match
// calls for candidates beyond this limit — out of scope for now, a straight cap is enough.
const APOLLO_BULK_MATCH_CAP = 10;

// Apollo's own default per-page result count for api_search is 10; explicit here rather than
// relying on the API's default so a future Apollo-side default change doesn't silently change
// this integration's behavior. Comfortably above APOLLO_BULK_MATCH_CAP so the pre-bulk_match
// priority sort (below) has more than 10 real candidates to choose from when a company has
// them, rather than being capped by page size before priority even gets a chance to matter.
const SEARCH_PER_PAGE = 25;

// 28.08 follow-up, second change — Apollo's include_similar_titles defaults to true when omitted
// from the request, silently expanding person_titles matches to similar-sounding titles. A
// plausible cause of the noisy near-duplicate "VP of Engineering" flood seen during manual
// testing on Karat. Set explicitly to false rather than left as an implicit default, and kept as
// its own named constant (not an inline literal in the request body) so it's trivial to flip to
// true later for a manual side-by-side comparison — that comparison is a live-call decision for
// the project owner to make and trigger, not something to test here.
const INCLUDE_SIMILAR_TITLES = false;

// 26.08 follow-up, THIRD revision — Owner/Co-Owner dropped from Apollo's search scope entirely.
// This is a scope reduction, not another query-level patch — CEO/CTO/Founder/Co-Founder/VP-level
// results are confirmed working correctly and stay as-is; Apollo simply cannot reliably surface
// company owners for this use case, and surfacing wrong "owners" is worse than surfacing none.
//
// History, both attempts confirmed wrong via live evidence, not theory:
// Revision 1: 'Owner'/'Co-Owner' as literal person_titles keywords. False positives: DriveWealth
// returned "Product Owner"/"Senior Product Owner" people; Sniffspot returned random LinkedIn
// users whose headline merely contained "Owner" (one literally "SniffSpot Host").
// Revision 2: moved Owner/Co-Owner coverage to Apollo's own person_seniorities: ['owner'] filter
// instead (a real, documented enum — confirmed against docs.apollo.io/reference/people-api-search:
// owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern), on the
// theory that a categorical field Apollo assigns itself would avoid a text-substring problem.
// WRONG — live-diagnosed by running the title-based and seniority-based searches separately and
// checking which one actually returned each bad candidate:
//   - DriveWealth: the seniority='owner' search returned ALL 6 bad candidates (Danni Lu, TJ
//     Maglia, Sal Am***o, Jose La***d, Shant Ke***n, Gagan Ka***r) — every single one titled
//     "Product Owner" or "Senior Product Owner". The title-based search's own results (CEO, CIO,
//     CTO, VP of Engineering x2, SVP Engineering) were all correct.
//   - Sniffspot: the seniority='owner' search returned exactly 2 people — one titled "Owner of
//     Mookie's Magic Meadows as a SniffSpot Host!" (a marketplace HOST listing their own yard,
//     not a Sniffspot employee) and one titled "Owner/operator Private dog Park" (same pattern —
//     someone who owns an unrelated small dog-park business that happens to list on Sniffspot's
//     marketplace). The title-based search correctly found the real Founder.
// Conclusion: Apollo's own internal seniority classification tags "Product Owner"-style job
// titles, and "owner of [unrelated small business]" LinkedIn headlines, as seniority=owner — this
// is Apollo's own data/heuristic, one layer deeper than our query text, not something fixable by
// changing how we ask. Apollo's data structurally cannot distinguish "owns/co-owns THIS company"
// from "has the word owner somewhere in their title or headline" for this use case. No third
// query-level fix attempted — per the same "false negative safer than false positive" principle
// already applied to the OpenAI DM path, Owner/Co-Owner are simply out of scope for Apollo.
const APOLLO_PERSON_TITLES = LPR_ROLES.filter((role) => role !== 'Owner' && role !== 'Co-Owner');

interface ApolloSearchCandidate {
  id: string;
  title: string;
}

interface ApolloMatchedPerson {
  id: string;
  name: string;
  title: string;
  linkedinUrl: string | null;
}

// Apollo's title text is real, human-written job-title data (e.g. "Chief Executive Officer",
// "VP, Engineering") — not one of our fixed LPR_ROLES strings, so it can't be run through
// openai-classifier.service.ts's roleSortIndex() directly (that expects an exact match against
// ROLE_PRIORITY_ORDER and silently treats anything else as lowest-priority). This is a
// deliberately loose, case-insensitive keyword heuristic to recover a priority ranking from real
// title text WITHOUT forcing the displayed role into our fixed enum (unlike OpenAI's DM path,
// Apollo's role is left as the real title Apollo returned — see the doc comment on
// searchLeadership's final mapping for why). Order matters: more specific keywords are checked
// first (e.g. "co-founder" before "founder") so a Co-Founder doesn't get misread as a Founder.
// UNVERIFIED against real Apollo title text — this project's very first live Apollo call will
// show whether these keywords actually match what Apollo returns; adjust from real evidence,
// same "implement from the written spec, then verify" pattern every other provider went through.
const ROLE_KEYWORDS: [string, string][] = [
  ['chief executive', 'CEO'],
  ['ceo', 'CEO'],
  ['co-founder', 'Co-Founder'],
  ['cofounder', 'Co-Founder'],
  ['founder', 'Founder'],
  ['co-owner', 'Co-Owner'],
  ['owner', 'Owner'],
  ['chief technology', 'CTO'],
  ['cto', 'CTO'],
  ['chief information', 'CIO'],
  ['cio', 'CIO'],
  ['chief operating', 'COO'],
  ['coo', 'COO'],
  ['general manager', 'General Manager'],
  ['vp, engineering', 'VP of Engineering'],
  ['vp of engineering', 'VP of Engineering'],
  ['vice president of engineering', 'VP of Engineering'],
  ['vp, technology', 'VP of Technology'],
  ['vp of technology', 'VP of Technology'],
  ['vice president of technology', 'VP of Technology'],
];

function apolloRolePriorityIndex(title: string): number {
  const lower = (title || '').toLowerCase();
  for (const [keyword, canonicalRole] of ROLE_KEYWORDS) {
    if (lower.includes(keyword)) return roleSortIndex(canonicalRole);
  }
  return ROLE_PRIORITY_ORDER.length;
}

function isApolloQuotaExhausted(status: number, data: unknown): boolean {
  if (status === 429) return true;
  const message = extractApolloErrorMessage(data);
  return !!message && /credit|quota|rate.?limit/i.test(message);
}

// Apollo's error response shape isn't confirmed against a real call — defensively checks the
// couple of field names their docs/community reports most commonly use ("error", "message",
// "error_message") rather than assuming one. Returns null (falls back to a plain "HTTP {status}"
// message upstream) if none of them are present, so a genuinely unexpected error shape still
// surfaces the raw status rather than silently showing nothing.
function extractApolloErrorMessage(data: unknown): string | null {
  const obj = data as { error?: unknown; message?: unknown; error_message?: unknown } | null;
  const candidate = obj?.error ?? obj?.message ?? obj?.error_message;
  return typeof candidate === 'string' ? candidate : null;
}

// Defensive, not strict — Apollo's api_search response wraps results in a `people` array (per
// their docs); each entry's `id` is required (nothing to look up without it), `title` is
// optional (kept for the pre-bulk_match priority sort, and as a last-resort role label if
// bulk_match's own title is somehow missing). Entries with no id are dropped rather than
// crashing the whole search over one malformed record.
function parseApolloSearchResponse(data: unknown): ApolloSearchCandidate[] {
  const people = (data as { people?: unknown } | null)?.people;
  if (!Array.isArray(people)) return [];
  return people
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      id: typeof p.id === 'string' ? p.id : '',
      title: typeof p.title === 'string' ? p.title : '',
    }))
    .filter((c) => c.id !== '');
}

// Defensive, not strict — same reasoning as parseApolloSearchResponse. bulk_match's response is
// expected to wrap results in a `matches` array (each shaped like a single Person Match result);
// falls back to `people` if a given response uses that key instead, since Apollo's own API has
// used both names for similar endpoints historically and this hasn't been confirmed against a
// real bulk_match response yet. `name` falls back to concatenating first_name/last_name if a
// combined `name` field isn't present.
function parseApolloBulkMatchResponse(data: unknown): ApolloMatchedPerson[] {
  const obj = data as { matches?: unknown; people?: unknown } | null;
  const rawMatches = Array.isArray(obj?.matches) ? obj?.matches : Array.isArray(obj?.people) ? obj?.people : [];
  if (!Array.isArray(rawMatches)) return [];
  return rawMatches
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => {
      const firstName = typeof p.first_name === 'string' ? p.first_name : '';
      const lastName = typeof p.last_name === 'string' ? p.last_name : '';
      const fallbackName = [firstName, lastName].filter(Boolean).join(' ');
      return {
        id: typeof p.id === 'string' ? p.id : '',
        name: typeof p.name === 'string' && p.name ? p.name : fallbackName,
        title: typeof p.title === 'string' ? p.title : '',
        linkedinUrl: typeof p.linkedin_url === 'string' && p.linkedin_url ? p.linkedin_url : null,
      };
    })
    .filter((m) => m.id !== '');
}

/**
 * Apollo.io provider for LPR ("DM") search (26.08 follow-up) — an alternate provider alongside
 * openai-classifier.service.ts/gemini-classifier.service.ts/claude-classifier.service.ts, same
 * searchLeadership(company, companyWebsite) contract, selectable via the dashboard's existing
 * provider dropdown (?provider=apollo).
 *
 * Architecturally simpler than the other three, and deliberately NOT built the same way: Apollo
 * is a maintained lookup database, not a generative model, so there's no hallucination risk to
 * guard against — a linkedin_url either exists in Apollo's own data for a given person or it
 * doesn't. None of OpenAI's three-way verification machinery (urlVerified / companyMatchConfirmed
 * / domainConfirmed) applies here; a linkedin_url returned by bulk_match is treated as verified
 * by construction. Two real calls per search (not OpenAI's forced 1+N architecture): one free
 * discovery search, one credit-consuming bulk_match for whichever candidates survive
 * APOLLO_BULK_MATCH_CAP.
 *
 * "No fabrication risk" does NOT mean "no data-quality risk" — see APOLLO_PERSON_TITLES's own
 * comment for a real, live-confirmed case: Apollo's own internal seniority classification
 * conflates "Product Owner" job titles and small-business "owner" LinkedIn headlines with actual
 * company ownership, which is why Owner/Co-Owner are deliberately out of scope here rather than
 * chased through a third query-level fix. Apollo genuinely doesn't hallucinate a person or a
 * URL — but it can hand back a real, verified link to the wrong kind of "owner."
 *
 * Response shapes (parseApolloSearchResponse/parseApolloBulkMatchResponse) have been confirmed
 * against real live calls (DriveWealth, Sniffspot) as of this revision — no longer purely
 * spec-implemented/unverified.
 */
@Injectable()
export class ApolloClassifierService {
  private readonly logger = new Logger(ApolloClassifierService.name);

  // DB access added 28.08 follow-up, solely for the organization_id cache (see
  // apollo_organization_id's own comment in schema.ts) — this provider had no DB dependency
  // before this change.
  constructor(@Inject(DB) private readonly db: Db) {}

  private get apiKey(): string {
    const key = process.env.APOLLO_API_KEY;
    if (!key) throw new Error('APOLLO_API_KEY is not set');
    return key;
  }

  // Reuse-forever cache read (28.08 follow-up): looks for ANY lead — regardless of which specific
  // lead this search was triggered for, and regardless of soft-delete state (an org id doesn't
  // stop being valid just because the LEAD that first resolved it was deleted) — that already has
  // a cached apollo_organization_id for this domain. company_website is a raw URL string (not a
  // normalized domain), so this can't be a simple SQL string-equality WHERE clause; instead it
  // pulls the (currently small — low thousands of rows) set of leads that already have a cached
  // org id and compares normalized domains in application code via the same extractDomain() used
  // for the search itself, so "cached for this domain" always means the exact same normalization
  // the rest of this file already relies on. Fine at current scale; if this table grows large
  // enough for that scan to matter, the real fix is a proper companies/organizations table, not a
  // cleverer WHERE clause — out of scope for this single, isolated change.
  private async getCachedOrganizationId(domain: string): Promise<string | null> {
    const rows = await this.db
      .select({ company_website: job_leads.company_website, apollo_organization_id: job_leads.apollo_organization_id })
      .from(job_leads)
      .where(isNotNull(job_leads.apollo_organization_id));

    for (const row of rows) {
      if (row.company_website && extractDomain(row.company_website) === domain && row.apollo_organization_id) {
        return row.apollo_organization_id;
      }
    }
    return null;
  }

  // Writes a newly-resolved organization id to every CURRENT lead sharing this domain that
  // doesn't already have one cached — not just the one lead that happened to trigger this
  // search — so the very next search for any other lead at this company hits
  // getCachedOrganizationId() above instead of spending another credit. Same domain-normalization
  // approach as the read above, same "fine at current scale" caveat. Best-effort: a failure here
  // is logged, not thrown — the search this call is part of already has its organizationId in
  // hand and should proceed regardless of whether the cache write succeeds.
  private async persistOrganizationId(domain: string, organizationId: string): Promise<void> {
    try {
      const rows = await this.db
        .select({ id: job_leads.id, company_website: job_leads.company_website })
        .from(job_leads)
        .where(and(isNull(job_leads.apollo_organization_id), isNotNull(job_leads.company_website)));

      const matchingIds = rows
        .filter((row) => row.company_website && extractDomain(row.company_website) === domain)
        .map((row) => row.id);

      if (matchingIds.length === 0) return;

      await this.db
        .update(job_leads)
        .set({ apollo_organization_id: organizationId, apollo_organization_resolved_at: new Date() })
        .where(inArray(job_leads.id, matchingIds));
    } catch (err) {
      this.logger.warn(`Apollo organization id cache write failed for domain "${domain}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // GET /organizations/enrich (28.08 follow-up) — resolves a domain to Apollo's own stable
  // organization_id, per Apollo's own recommendation that this is more reliable than
  // q_organization_domains_list (which breaks on subdomains, redirects, and multi-brand domains
  // sharing one domain). Costs 1 credit — see ORG_ENRICH_PATH's own comment — which is exactly
  // why this is cached (getCachedOrganizationId/persistOrganizationId above) rather than called
  // on every search. `name` is optional and, per Apollo's docs, improves match confidence when
  // provided alongside domain.
  //
  // Returns null — never throws, no retries — for EVERY failure mode alike: a genuine "no such
  // organization" (Apollo's docs don't specify whether that's a 404 or a 200 with an empty/null
  // organization field, so both are handled), a malformed response, an HTTP error, or a network
  // failure. The caller only ever sees "couldn't resolve" vs. "resolved" — never a distinguished
  // error — because searchLeadership's fallback behavior is identical either way: proceed with
  // the existing domain-based search. Collapsing every failure into one null return is what makes
  // that fallback simple and unconditional rather than needing its own error-classification logic.
  private async resolveOrganizationId(domain: string, name?: string): Promise<string | null> {
    const params = new URLSearchParams({ domain });
    if (name) params.set('name', name);

    let data: unknown;
    let status: number;
    try {
      const res = await fetch(`${API_BASE}${ORG_ENRICH_PATH}?${params.toString()}`, {
        method: 'GET',
        headers: { 'x-api-key': this.apiKey },
      });
      status = res.status;
      data = await res.json().catch(() => null);
    } catch (err) {
      this.logger.warn(`Apollo organization enrich request error for domain "${domain}": ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    if (status < 200 || status >= 300) {
      const message = extractApolloErrorMessage(data) ?? `HTTP ${status}`;
      this.logger.log(`[APOLLO DEBUG] organization enrich for domain "${domain}": no match (${message})`);
      return null;
    }

    const orgId = (data as { organization?: { id?: unknown } } | null)?.organization?.id;
    if (typeof orgId !== 'string' || orgId === '') {
      this.logger.log(`[APOLLO DEBUG] organization enrich for domain "${domain}": 200 response but no organization.id present`);
      return null;
    }

    this.logger.log(`[APOLLO DEBUG] organization enrich for domain "${domain}" resolved to organization_id "${orgId}" (1 credit spent)`);
    return orgId;
  }

  // The one mixed_people/api_search call this provider makes now (26.08 follow-up, third
  // revision — see APOLLO_PERSON_TITLES's own comment for why a second, person_seniorities-based
  // call was tried and then removed: Apollo's own seniority classification turned out to have the
  // same false-positive problem as a literal "Owner" title keyword did, just one layer deeper in
  // Apollo's data). Kept as its own method mainly for the same request/error-handling shape every
  // other provider call in this file uses. Never throws — a request error or non-2xx response
  // resolves to an empty candidate list plus an `error` string.
  //
  // `organizationFilter` (28.08 follow-up) is whichever single filter searchLeadership decided to
  // use for this call — `{ organization_ids: [id] }` when a cached/freshly-resolved organization
  // id is available (Apollo's own recommended, more reliable filter), or
  // `{ q_organization_domains_list: [domain] }` as the fallback when resolution found no match.
  // Exactly one of the two, never both — this method doesn't choose, it just sends what it's given.
  private async runApolloSearch(
    organizationFilter: { organization_ids: string[] } | { q_organization_domains_list: string[] },
  ): Promise<{ candidates: ApolloSearchCandidate[]; raw: string; error?: string; quotaExhausted: boolean }> {
    let data: unknown;
    try {
      const res = await fetch(`${API_BASE}${SEARCH_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify({
          ...organizationFilter,
          per_page: SEARCH_PER_PAGE,
          person_titles: APOLLO_PERSON_TITLES,
          include_similar_titles: INCLUDE_SIMILAR_TITLES,
        }),
      });
      data = await res.json();
      if (!res.ok) {
        const quotaExhausted = isApolloQuotaExhausted(res.status, data);
        const message = extractApolloErrorMessage(data) ?? `HTTP ${res.status}`;
        this.logger.warn(`Apollo search failed (HTTP ${res.status}): ${message}`);
        return { candidates: [], raw: JSON.stringify(data), error: message, quotaExhausted };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Apollo search request error: ${message}`);
      return { candidates: [], raw: '', error: message, quotaExhausted: false };
    }

    // TEMPORARY DEBUG LOGGING — first-integration visibility, same pattern used when every other
    // provider in this project was first wired up. Remove once a real response has confirmed the
    // parsing below matches Apollo's actual shape.
    this.logger.log(`[APOLLO DEBUG] search raw response: ${JSON.stringify(data).slice(0, 3000)}`);

    return { candidates: parseApolloSearchResponse(data), raw: JSON.stringify(data), quotaExhausted: false };
  }

  async searchLeadership(company: string, companyWebsite: string | null): Promise<LprSearchResult> {
    if (!companyWebsite) {
      return {
        ok: false,
        people: [],
        raw: '',
        error: 'This lead has no company website on file — Apollo search requires a domain to filter on.',
        quotaExhausted: false,
      };
    }

    const domain = extractDomain(companyWebsite);
    if (!domain) {
      return {
        ok: false,
        people: [],
        raw: '',
        error: `Could not extract a usable domain from company_website ("${companyWebsite}") for Apollo's domain filter.`,
        quotaExhausted: false,
      };
    }

    // ---- Organization id resolution (28.08 follow-up) — cached, at most 1 credit per company ----
    // Reuse-forever: check every currently-cached id first; only spend a credit resolving a
    // domain that's never been resolved by ANY lead. A resolution failure (no match, error,
    // network issue — resolveOrganizationId collapses all of these to null, see its own comment)
    // falls back to the pre-existing domain-based filter rather than failing the lead, per spec.
    let organizationId = await this.getCachedOrganizationId(domain);
    if (!organizationId) {
      organizationId = await this.resolveOrganizationId(domain, company);
      if (organizationId) {
        await this.persistOrganizationId(domain, organizationId);
      }
    }
    const organizationFilter = organizationId
      ? { organization_ids: [organizationId] }
      : { q_organization_domains_list: [domain] };
    this.logger.log(`[APOLLO DEBUG] search filter for domain "${domain}": ${JSON.stringify(organizationFilter)}`);

    // ---- Step 1: mixed_people/api_search — free, obfuscated names, id + title only ----
    const searchResult = await this.runApolloSearch(organizationFilter);
    if (searchResult.error) {
      return {
        ok: false,
        people: [],
        raw: searchResult.raw,
        error: searchResult.error,
        quotaExhausted: searchResult.quotaExhausted,
      };
    }

    const candidates = searchResult.candidates;
    const combinedRaw = searchResult.raw;

    const filterDescription = organizationId ? `organization_id "${organizationId}"` : `domain "${domain}" (fallback — no cached/resolved organization id)`;

    if (candidates.length === 0) {
      return {
        ok: true,
        people: [],
        raw: combinedRaw,
        reasoning: `Apollo search: 0 candidates found for ${filterDescription} (titles: ${APOLLO_PERSON_TITLES.join(', ')}).`,
        quotaExhausted: false,
      };
    }

    // Priority-sorted before the bulk_match cap (see APOLLO_BULK_MATCH_CAP's own comment) so a
    // limited credit-consuming lookup goes to the most relevant candidates first — same
    // "sort before spending the expensive call" principle as OpenAI's DM path.
    const prioritized = [...candidates].sort(
      (a, b) => apolloRolePriorityIndex(a.title) - apolloRolePriorityIndex(b.title),
    );
    const toMatch = prioritized.slice(0, APOLLO_BULK_MATCH_CAP);
    const overflowCount = prioritized.length - toMatch.length;
    if (overflowCount > 0) {
      this.logger.log(`[APOLLO DEBUG] ${overflowCount} candidate(s) past APOLLO_BULK_MATCH_CAP (${APOLLO_BULK_MATCH_CAP}) — skipped, no bulk_match credits spent on them`);
    }

    // ---- Step 2: people/bulk_match — costs credits, never reveals email/phone ----
    let matchData: unknown;
    try {
      const res = await fetch(`${API_BASE}${BULK_MATCH_PATH}?reveal_personal_emails=false&reveal_phone_number=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify({
          reveal_personal_emails: false,
          reveal_phone_number: false,
          details: toMatch.map((c) => ({ id: c.id })),
        }),
      });
      matchData = await res.json();
      if (!res.ok) {
        const quotaExhausted = isApolloQuotaExhausted(res.status, matchData);
        const message = extractApolloErrorMessage(matchData) ?? `HTTP ${res.status}`;
        this.logger.warn(`Apollo bulk_match (step 2) failed (HTTP ${res.status}): ${message}`);
        return { ok: false, people: [], raw: combinedRaw, error: message, quotaExhausted };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Apollo bulk_match (step 2) request error: ${message}`);
      return { ok: false, people: [], raw: combinedRaw, error: message, quotaExhausted: false };
    }

    this.logger.log(`[APOLLO DEBUG] step2 (bulk_match) raw response: ${JSON.stringify(matchData).slice(0, 3000)}`);

    const matched = parseApolloBulkMatchResponse(matchData);

    // Apollo is a maintained lookup database, not a generative model — no fabrication risk the
    // way the other three providers have, so no urlVerified/companyMatchConfirmed/
    // domainConfirmed pipeline here (see this class's own doc comment). A match with a real
    // linkedin_url is included and marked verified by construction; a match with none is simply
    // excluded — same "no unverified middle state" principle OpenAI's DM path settled on, just
    // arrived at for a different reason (here, because Apollo genuinely has nothing on that
    // person rather than because a claim couldn't be cross-checked).
    const people: LprPerson[] = matched
      .filter((m): m is ApolloMatchedPerson & { linkedinUrl: string } => !!m.linkedinUrl)
      .map((m) => ({
        role: m.title || 'Unknown',
        name: m.name || 'Unknown',
        linkedin_url: m.linkedinUrl,
        linkedin_url_verified: true,
      }));

    const finalPeople = [...people]
      .sort((a, b) => apolloRolePriorityIndex(a.role) - apolloRolePriorityIndex(b.role))
      .slice(0, FINAL_PEOPLE_CAP);
    const droppedByCap = people.length - finalPeople.length;

    const reasoningParts = [
      `Apollo search: ${candidates.length} candidate(s) found for ${filterDescription}`,
      `${toMatch.length} sent to bulk_match${overflowCount > 0 ? ` (${overflowCount} skipped past cap)` : ''}`,
      `${people.length} matched with a real linkedin_url`,
      droppedByCap > 0 ? `${droppedByCap} trimmed past FINAL_PEOPLE_CAP (${FINAL_PEOPLE_CAP})` : null,
    ].filter(Boolean);

    return {
      ok: true,
      people: finalPeople,
      raw: JSON.stringify(matchData),
      reasoning: reasoningParts.join('; '),
      quotaExhausted: false,
    };
  }
}
