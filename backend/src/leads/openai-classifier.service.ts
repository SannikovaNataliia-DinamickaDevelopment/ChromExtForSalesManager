import { Injectable, Logger } from '@nestjs/common';
import OpenAI, { RateLimitError } from 'openai';
import { LPR_ROLES, type LprPerson, type LprSearchResult } from './gemini-classifier.service';

// 20.08 follow-up: OpenAI/ChatGPT is now the PRODUCTION LPR-search provider (persisted — see
// leads.service.ts's lprSearch). Gemini's grounded search is blocked (no billing on the
// free-tier key) and Claude, while it worked in one live test, cost ~$0.65/lead and exposed a
// parser bug: its web_search responses include narrative "thinking out loud" text before the
// final JSON array, which the shared lenient parseLprPeople() doesn't handle and silently
// turns into an empty result. This provider sidesteps that whole bug class with OpenAI's
// Structured Outputs (a strict json_schema response format) for the final answer, instead of
// "please respond with only JSON" prompt instructions plus lenient text parsing.
//
// Model (confirmed 2026-08-20 against OpenAI's own docs, not assumed): gpt-4.1-mini is the
// cheapest model that currently supports the Responses API's `web_search` tool
// ($0.40/$1.60 per 1M input/output tokens). gpt-4o-mini is cheaper per-token but is NOT in
// OpenAI's documented list of web_search-compatible models. The gpt-5.x family (gpt-5, gpt-5.5,
// gpt-5.6) all support it too but cost 5-12x more per token for no benefit this task needs.
const MODEL = 'gpt-4.1-mini';

// ARCHITECTURE (20.08 follow-up, third revision): forced 1+N calls, not one agentic turn.
// Earlier attempts asked the model to run a "two-phase" search (broad discovery, then per-person
// LinkedIn lookups) WITHIN a single Responses API call, trusting it to voluntarily chain a
// second round of tool calls. Confirmed via live testing (raw evidence, same DriveWealth lead,
// repeated) that this doesn't reliably happen: the model runs one broad search, then writes its
// final answer straight away — sometimes fabricating a plausible-looking URL, sometimes
// (observed) recalling a real one from training data rather than from anything it actually
// searched for in that run. Either way, action.sources for that single call never contains a
// real linkedin.com/in/ URL to verify against, because no per-person search ever happened.
//
// Fix: don't ask the model to decide when to make a second search — the application drives it.
// Phase 1 (searchLeadership below) is ONE call: broad discovery only, returns {role, name}
// pairs, no URL requested at all (nothing to fabricate if it's never asked for). Phase 2
// (searchPersonLinkedin below) is a SEPARATE, INDIVIDUALLY FORCED call per candidate — its own
// web_search tool, its own action.sources cross-check — run once per person, guaranteed, not
// left to model discretion. Cost is confirmed a non-issue at this scale (~$0.01-0.015/call,
// from real [LPR COST] log data during today's incident investigation — see PHASE2_CANDIDATE_CAP
// below for why the cap is a sanity limit, not a real cost constraint).
const PHASE1_MAX_OUTPUT_TOKENS = 4096;
// Phase 2 only ever needs to emit one short JSON object ({linkedin_url: "..."}) — no reason to
// share phase 1's larger budget, which exists for grounding across potentially many candidates.
const PHASE2_MAX_OUTPUT_TOKENS = 1024;
// A sanity ceiling, not a real constraint (confirmed cost ~$0.01-0.015/call makes even 10 extra
// calls negligible) — exists so a company with an unusually long candidate list can't run away
// with an unbounded number of calls. Candidates beyond this cap still appear in the result as
// name+role (phase 1 found them, that's still real information) — they just never get an
// individual phase-2 lookup, same as any other unverified entry.
const PHASE2_CANDIDATE_CAP = 10;

// 24.08 follow-up, fifth revision: web_search results for the same person/query are
// non-deterministic between calls (confirmed live — see searchPersonLinkedin's own doc comment)
// — a genuinely real person can fail verification on one attempt and pass on the next with no
// change to the prompt. Up to 2 retries (3 attempts total) per candidate before giving up, same
// trust bar every attempt. Cost stays negligible at this scale even 3x'd (~$0.03-0.045/candidate
// worst case) — see PHASE2_CANDIDATE_CAP's own comment for the underlying per-call cost data.
const PHASE2_MAX_ATTEMPTS_PER_CANDIDATE = 3;

// 24.08 follow-up bug fix: a scale/relevance problem, not a hallucination one — one lead
// (Karat) returned 26 "people," nearly all "VP of Engineering," because a large company's team
// page lists many people under a shared title and phase 1 reported all of them. This caps what
// actually gets SAVED to a lead, separate from PHASE2_CANDIDATE_CAP above (a cost sanity limit
// on lookups, not a usability limit on the final list). 8, reasoning: LPR_ROLES has 11 distinct
// role labels, but a genuinely useful outreach list is CEO/Founder-type roles (rare, always
// relevant, at most 1-2 people) plus a handful of other C-level/VP names — not one slot per
// possible title. 8 leaves room for that real diversity without becoming an unusable roster
// dump; trimming favors ROLE_PRIORITY_ORDER below (company-wide leadership first) rather than
// an arbitrary first-N cut, so a late-listed CEO is never dropped in favor of an early-listed
// VP of Engineering when both can't fit.
const FINAL_PEOPLE_CAP = 8;

// Same 11 values as LPR_ROLES, reordered by how uniquely relevant a role is for outreach —
// CEO/Founder-type roles are rare (usually exactly one real person per company) and always
// worth contacting; VP-of-X titles are the ones most likely to be shared by many people at a
// larger company (see FINAL_PEOPLE_CAP's comment — this is exactly what went wrong for Karat),
// so they're deprioritized when trimming to the cap. Must stay the same SET of values as
// LPR_ROLES (just reordered) — roleSortIndex below falls back to "lowest priority" for anything
// not found here, so a drift wouldn't break, just silently stop prioritizing that role.
const ROLE_PRIORITY_ORDER = [
  'CEO', 'Founder', 'Co-Founder', 'Owner', 'Co-Owner',
  'CTO', 'CIO', 'COO', 'General Manager',
  'VP of Engineering', 'VP of Technology',
];

// 24.08 follow-up, sixth revision: the top tier of ROLE_PRIORITY_ORDER — used to scope the extra
// company-website-search attempt (see searchPersonLinkedin's own comment) to exactly the roles
// where the Juniper Square test found a systematic verification gap (real CEO/Co-Founders failed
// while COO/VP-of-Engineering passed). Not the whole role list — a company's own Team/About page
// is a startup-founder convention, not something every VP-level hire is likely to be listed on,
// so there's no reason to spend the extra call outside this tier.
const TOP_TIER_ROLES = ['CEO', 'Founder', 'Co-Founder', 'Owner', 'Co-Owner'];

function roleSortIndex(role: string): number {
  const i = ROLE_PRIORITY_ORDER.indexOf(role);
  return i === -1 ? ROLE_PRIORITY_ORDER.length : i;
}

// Stable sort by role priority — ties (same role) keep their original relative order rather
// than being reshuffled, so this can be applied more than once (before phase-2 selection, then
// again before the final cap) without scrambling order each time.
function sortByRolePriority<T extends { role: string }>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => roleSortIndex(a.item.role) - roleSortIndex(b.item.role) || a.i - b.i)
    .map(({ item }) => item);
}

// Structured Outputs requires an OBJECT at the schema root — a bare JSON array is rejected
// (confirmed via OpenAI's own docs, not assumed) — hence the {people: [...]} / {linkedin_url}
// wrappers below rather than array/bare-string schemas.
//
// role is a strict enum of LPR_ROLES (20.08 follow-up bug fix), not a free string: production
// results were coming back with titles like "Chief Financial Officer" / "Chief People Officer" /
// "General Counsel and Corporate Secretary" that aren't in LPR_ROLES at all — the prompt's own
// "map onto this list" instruction was being silently ignored because nothing in the schema
// actually enforced it. An enum makes that a real, constrained-decoding-level guarantee instead
// of a suggestion. See searchLeadership's prompt for how "no reasonable mapping exists" is
// handled (exclude the person, don't force a wrong mapping) — the schema alone can't express
// that judgment call, only the prompt can.
//
// No linkedin_url field here at all (20.08 architecture change) — phase 1 is discovery-only.
const PHASE1_SCHEMA = {
  type: 'object',
  properties: {
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: LPR_ROLES },
          name: { type: 'string' },
        },
        required: ['role', 'name'],
        additionalProperties: false,
      },
    },
  },
  required: ['people'],
  additionalProperties: false,
};

// Phase 2's schema — a single URL, since this call is already scoped to one known person.
// company_match_confirmed (24.08 follow-up, second revision): replaces a blunt post-hoc
// domain-string check that turned out to reject genuinely correct matches (real bio sources like
// theorg.com/crunchbase describe an employer in TEXT, without ever linking to the company's own
// domain) while doing nothing to actually rule out a same-named-company collision (action.sources
// exposes bare URLs, not page content, so there's nothing to string-match against that content
// anyway). This asks the model to make the actual judgment call it's the only party positioned
// to make — it read the search results, it can say whether they connect this person to THIS
// company. Required (strict Structured Outputs), so the model can't omit it — see
// searchPersonLinkedin's prompt for why "true" requires real evidence, not a default.
const PHASE2_SCHEMA = {
  type: 'object',
  properties: {
    linkedin_url: { type: 'string' },
    company_match_confirmed: { type: 'boolean' },
  },
  required: ['linkedin_url', 'company_match_confirmed'],
  additionalProperties: false,
};

interface Phase1Candidate {
  role: string;
  name: string;
}

@Injectable()
export class OpenaiClassifierService {
  private readonly logger = new Logger(OpenaiClassifierService.name);

  private get apiKey(): string {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not set');
    return key;
  }

  /**
   * Production LPR search provider (20.08 follow-up) — same contract as
   * GeminiClassifierService.searchLeadership / ClaudeClassifierService.searchLeadership: real
   * web search only, never a plausible-looking guess from training data. Unlike them, both the
   * discovery step and every per-person URL lookup are constrained by a strict json_schema
   * response format (Structured Outputs), and — as of this revision — driven as separate,
   * application-forced calls (see this file's top-of-file architecture comment) rather than one
   * agentic turn the model might or might not extend on its own.
   */
  async searchLeadership(company: string, companyWebsite: string | null): Promise<LprSearchResult> {
    const client = new OpenAI({ apiKey: this.apiKey });

    // ---- Phase 1: broad discovery, name+role only ----
    const phase1Prompt = [
      'You are researching the leadership of a specific company using live web search.',
      '',
      `Company name: ${company}`,
      companyWebsite ? `Company website: ${companyWebsite}` : 'Company website: not provided.',
      '',
      `Search for people who CURRENTLY hold any of these roles at this specific company: ${LPR_ROLES.join(', ')}.`,
      '',
      'Run a broad search whose query text names SEVERAL of the specific roles listed above ' +
        'together with the company name — not a short, generic phrase. A query naming multiple ' +
        'specific roles surfaces far more useful results than a vague one.',
      '',
      'For each person you find, report their role (use whichever of the roles above best ' +
        'matches what you found) and full name. The role you report MUST be exactly one of the ' +
        'roles listed above — if a person’s real title is a clear equivalent of one of those ' +
        'roles (e.g. "Chief Technology Officer" → CTO), map it. If it genuinely is NOT ' +
        'equivalent to any role on that list (e.g. Chief Financial Officer, Chief People ' +
        'Officer, General Counsel — these have no match above), do NOT force them into the ' +
        'closest-sounding role just to include them — leave that person out of the results ' +
        'entirely instead. A wrong role label is worse than a missing person.',
      '',
      'CRITICAL: Only include a person if your search genuinely found evidence they currently ' +
        'hold one of the listed roles at this company. Never guess, infer, or fabricate a name ' +
        'from general knowledge or common naming patterns — if nothing you searched confirms ' +
        'someone holds one of the listed roles, leave them out entirely.',
      '',
      'CRITICAL: Report each person’s full first and last name — never abbreviate to initials ' +
        'or a partial name.',
      '',
      'CRITICAL: You are looking for a SMALL number of top-level decision-makers, not a full ' +
        'team roster. If a page or listing shows many people sharing a similar title (a large ' +
        'company’s engineering organization can have many people who all carry some variant of ' +
        'a title like VP of Engineering), do not report all of them — favor company-wide ' +
        'leadership (CEO, Founder, CTO, COO) and include only the handful of people at the very ' +
        'top of each relevant area, not every person who holds a matching-sounding title.',
      '',
      'Do NOT report a LinkedIn URL or any other profile link in this step — only role and ' +
        'name. Each person’s LinkedIn profile will be looked up in a separate, dedicated step ' +
        'afterward, so it is not needed here.',
    ].join('\n');

    let phase1Response: OpenAI.Responses.Response;
    try {
      phase1Response = await client.responses.create({
        model: MODEL,
        input: phase1Prompt,
        max_output_tokens: PHASE1_MAX_OUTPUT_TOKENS,
        tools: [{ type: 'web_search' }],
        include: ['web_search_call.action.sources'],
        text: {
          format: {
            type: 'json_schema',
            name: 'lpr_candidates',
            strict: true,
            schema: PHASE1_SCHEMA,
          },
        },
      });
    } catch (err) {
      const quotaExhausted = err instanceof RateLimitError;
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(`OpenAI LPR phase-1 search request error: ${errorMessage}`);
      return { ok: false, people: [], raw: '', error: errorMessage, quotaExhausted };
    }

    logCallCost(this.logger, 'phase1', phase1Response);

    const phase1Text = phase1Response.output_text ?? '';
    const phase1Queries = extractSearchQueries(phase1Response);

    // Dedupe by name (trimmed, case-insensitive) — phase 1's own final JSON has been observed
    // repeating the same person twice in a single response, sometimes under TWO DIFFERENT roles
    // (e.g. Yonas Fisseha listed as both "VP of Engineering" and "Co-Founder" — a real dual
    // title, not a hallucination). This is the CHEAP, pre-phase-2 dedupe pass (catches
    // exact-string repeats before spending a lookup call on them); a second, URL-based pass
    // after phase 2 (below) catches name VARIANTS of the same person (e.g. "Mike Liberty" vs
    // "Michael Liberty") that this pass can't, since it only has strings to compare at this
    // point.
    //
    // 24.08 follow-up, seventh revision, bug fix: this used to keep whichever occurrence came
    // FIRST in phase 1's own (arbitrary) output order — for Yonas Fisseha, "VP of Engineering"
    // happened to be listed before "Co-Founder", so his real Co-Founder title was silently
    // discarded, which then wrongly excluded him from the TOP_TIER_ROLES company-site search
    // attempt below (he was never actually less than a Co-Founder — the dedupe just picked the
    // wrong duplicate). Fixed to keep the HIGHER-PRIORITY role per ROLE_PRIORITY_ORDER
    // regardless of which one phase 1 happened to list first — a Map so a later, higher-priority
    // duplicate can still overwrite an earlier, lower-priority one.
    const byName = new Map<string, Phase1Candidate>();
    for (const c of parsePhase1Candidates(phase1Text)) {
      const key = c.name.trim().toLowerCase();
      const existing = byName.get(key);
      if (!existing || roleSortIndex(c.role) < roleSortIndex(existing.role)) {
        byName.set(key, c);
      }
    }
    const namedCandidates = Array.from(byName.values());
    // Priority-sorted BEFORE the phase-2 cap (24.08 follow-up) — so a limited lookup budget goes
    // to the most relevant candidates first (CEO/Founder-type roles) rather than whichever ones
    // happened to appear earliest in phase 1's own (arbitrary) output order.
    const candidates = sortByRolePriority(namedCandidates);

    const toLookUp = candidates.slice(0, PHASE2_CANDIDATE_CAP);
    const overflow = candidates.slice(PHASE2_CANDIDATE_CAP);
    if (overflow.length > 0) {
      // 24.08 follow-up, second revision: overflow candidates never get a phase-2 lookup, so
      // there's no way to confirm they're the right company — excluded entirely rather than
      // surfaced as name+role (see this method's "no unverified middle state" doc comment above
      // the people.push logic below).
      this.logger.log(`[LPR DEBUG] ${overflow.length} candidate(s) past PHASE2_CANDIDATE_CAP (${PHASE2_CANDIDATE_CAP}) — excluded, no phase-2 lookup so company match can't be confirmed`);
    }

    // ---- Phase 2: one SEPARATE, individually forced call per candidate ----
    // Promise.allSettled, not Promise.all: one candidate's search failing (rate limit, network)
    // must not lose every other candidate's result — same "no silent failures, don't let one bad
    // item abort the run" principle used throughout this codebase's other batch flows.
    const phase2Settled = await Promise.allSettled(
      toLookUp.map((c) => this.searchPersonLinkedin(client, c, company, companyWebsite)),
    );

    const allQueries = [...phase1Queries];
    const people: LprPerson[] = [];

    // 24.08 follow-up, second revision: this is a deliberate reversal of the earlier "flag,
    // don't drop" design for THIS provider specifically. Previously an unverified/failed/
    // overflow candidate was still pushed with a blank URL — a "here's a name, but we couldn't
    // confirm it" middle state, surfaced in the dashboard as greyed-out/unclickable. The Karat
    // incident showed why that's not good enough on its own: a name+role that might belong to a
    // different, same-named company is still noise someone has to manually re-check — the goal
    // is a list Mariia can act on directly, not one she has to re-verify. So as of this
    // revision, only a candidate whose phase-2 call BOTH returned a real, sources-verified URL
    // AND had company_match_confirmed === true from the model gets included at all; everything
    // else (unverified, failed call, or never looked up due to the phase-2 cap) is excluded from
    // the result entirely, logged for visibility, never surfaced as a person.
    phase2Settled.forEach((settled, i) => {
      const candidate = toLookUp[i];
      if (settled.status === 'fulfilled') {
        allQueries.push(...settled.value.queries);
        if (settled.value.verified) {
          people.push({ role: candidate.role, name: candidate.name, linkedin_url: settled.value.linkedinUrl, linkedin_url_verified: true });
        } else {
          this.logger.log(`[LPR DEBUG] "${candidate.name}" excluded — phase-2 could not confirm both a real URL and the correct company`);
        }
      } else {
        // The dedicated per-person call itself failed (rate limit, network, etc.) — with no
        // company-match confirmation obtained, this candidate can't be told apart from a
        // same-named-company collision, so it's excluded rather than surfaced unverified.
        this.logger.warn(`OpenAI LPR phase-2 search failed for "${candidate.name}": ${String(settled.reason)} — excluded`);
      }
    });

    const deduped = dedupeByUrlThenName(people);
    // Final priority-sorted cap (FINAL_PEOPLE_CAP's own comment has the reasoning) — applied
    // AFTER dedup so the cap counts real distinct people, not URL/name duplicates. Candidates
    // were already priority-sorted going into phase 2, so this mostly just trims the tail; it's
    // reapplied here (not assumed to already hold) because dedup can change which entries survive
    // and in what order.
    const finalPeople = sortByRolePriority(deduped).slice(0, FINAL_PEOPLE_CAP);
    const droppedByCap = deduped.length - finalPeople.length;
    if (droppedByCap > 0) {
      this.logger.log(`[LPR DEBUG] ${droppedByCap} deduped candidate(s) past FINAL_PEOPLE_CAP (${FINAL_PEOPLE_CAP}) — not saved`);
    }

    const reasoning = allQueries.length > 0 ? `Searched: ${allQueries.join('; ')}` : undefined;

    return { ok: true, people: finalPeople, raw: phase1Text, reasoning, quotaExhausted: false };
  }

  // Phase 2: ONE dedicated, forced web-search call for exactly one already-identified person —
  // never left to the model's own discretion about whether to search further (that discretion is
  // exactly what phase 1's old "two-phase in one turn" design relied on, and what didn't hold up
  // under live testing). Throws on request failure (caught by the caller's Promise.allSettled);
  // returns a verified/unverified result otherwise, using the SAME action.sources cross-check
  // built for the single-call design (normalizeForComparison below), scoped to just this call's
  // own sources — PLUS a company-identity check (24.08 follow-up bug fix, see this method's own
  // doc comment further down for the full incident).
  // 24.08 follow-up, fifth revision: web_search's own results are non-deterministic between
  // calls — live-tested on this exact lead, the SAME person (Mohit Bhende) got a real,
  // verifiable linkedin.com source on one call and no usable source at all on the next, with no
  // change to the prompt or candidate. A single phase-2 attempt is therefore testing search luck
  // as much as it's testing whether the person is real. This retries up to
  // PHASE2_MAX_ATTEMPTS_PER_CANDIDATE independent search rolls for the SAME candidate before
  // giving up — same trust bar every attempt, just more chances to land a verifiable one. Stops
  // at the first attempt that verifies; only exhausts all attempts when every one fails.
  //
  // 24.08 follow-up, sixth revision: live testing (Juniper Square, a normal non-adversarial
  // company) found the general search above has a systematic gap for exactly the highest-value
  // roles — the real CEO and both real Co-Founders failed verification while the COO and a VP of
  // Engineering passed. For TOP_TIER_ROLES candidates only, if every general attempt still comes
  // back unverified, this adds ONE further attempt with a differently targeted search — the
  // company's own website rather than the open web (searchPersonLinkedinAttempt's own doc
  // comment on the company-site prompt has the reasoning for why that's a distinct, not
  // redundant, search). Same verification logic, same trust bar — just one more, better-aimed
  // roll for the roles that most need it.
  //
  // 24.08 follow-up, eighth revision — ATTEMPTED, REVERTED: tried restricting the first general
  // attempt to linkedin.com via the web_search tool's own `filters.allowed_domains` (the real,
  // documented mechanism — not a `site:` query-text hint, which OpenAI's docs don't list as
  // honored). Live-tested across the same 5-lead sample and reverted immediately: the API itself
  // rejects it — `Error: 400 Parameter 'filters' not supported with model 'gpt-4.1-mini'` — on
  // every single phase-2 call, so every candidate on every lead failed outright and got excluded,
  // including Juniper Square's previously-verified Stephanie D. Miller/Adam Hyder (0/19 verified
  // this run vs. 2/19 before). `filters` requires a newer web_search tool version tied to a
  // different model than the one this file uses for cost reasons — not compatible as a drop-in
  // change. Reverted to the unrestricted call every attempt used before this revision.
  private async searchPersonLinkedin(
    client: OpenAI,
    candidate: Phase1Candidate,
    company: string,
    companyWebsite: string | null,
  ): Promise<{ linkedinUrl: string; verified: boolean; queries: string[] }> {
    const companyIdentifier = companyWebsite ? `${company} (${companyWebsite})` : company;
    const allQueries: string[] = [];
    let last: { linkedinUrl: string; verified: boolean; queries: string[] } = { linkedinUrl: '', verified: false, queries: [] };

    for (let attempt = 1; attempt <= PHASE2_MAX_ATTEMPTS_PER_CANDIDATE; attempt++) {
      const prompt = buildGeneralPhase2Prompt(candidate, companyIdentifier);
      last = await this.searchPersonLinkedinAttempt(client, candidate, prompt, `general ${attempt}/${PHASE2_MAX_ATTEMPTS_PER_CANDIDATE}`, companyWebsite);
      allQueries.push(...last.queries);
      if (last.verified) break;
    }

    if (!last.verified && companyWebsite && TOP_TIER_ROLES.includes(candidate.role)) {
      const prompt = buildCompanySitePhase2Prompt(candidate, company, companyWebsite);
      last = await this.searchPersonLinkedinAttempt(client, candidate, prompt, 'company-site', companyWebsite);
      allQueries.push(...last.queries);
    }

    return { linkedinUrl: last.linkedinUrl, verified: last.verified, queries: allQueries };
  }

  // Single search-and-verify attempt — unchanged trust bar regardless of which prompt is passed
  // in (general open-web search vs. the company-site-scoped search, see searchPersonLinkedin
  // above). `attemptLabel` is only used for the debug log line below (which attempt produced
  // which result).
  //
  // 24.08 follow-up, eighth revision — ATTEMPTED, REVERTED: this briefly took an `allowedDomains`
  // param and passed it as the web_search tool's `filters.allowed_domains` to restrict the first
  // attempt to linkedin.com. Reverted after a live test across the 5-lead sample threw
  // `Error: 400 Parameter 'filters' not supported with model 'gpt-4.1-mini'` on every call — see
  // searchPersonLinkedin's own doc comment for the full incident. Back to the plain, unrestricted
  // tool call every attempt has always used.
  private async searchPersonLinkedinAttempt(
    client: OpenAI,
    candidate: Phase1Candidate,
    prompt: string,
    attemptLabel: string,
    companyWebsite: string | null,
  ): Promise<{ linkedinUrl: string; verified: boolean; queries: string[] }> {
    const response = await client.responses.create({
      model: MODEL,
      input: prompt,
      max_output_tokens: PHASE2_MAX_OUTPUT_TOKENS,
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
      text: {
        format: {
          type: 'json_schema',
          name: 'lpr_person_url',
          strict: true,
          schema: PHASE2_SCHEMA,
        },
      },
    });

    logCallCost(this.logger, `phase2:${candidate.name}`, response);

    const queries = extractSearchQueries(response);
    const rawSourceUrls = extractRawSourceUrls(response);
    const realUrls = new Set(rawSourceUrls.map((u) => normalizeForComparison(u)));

    const { linkedinUrl: modelUrlRaw, companyMatchConfirmed } = parsePhase2Response(response.output_text ?? '');
    const modelUrl = modelUrlRaw.trim();
    const normalizedModelUrl = normalizeForComparison(modelUrl);
    const urlVerifiedExact = modelUrl !== '' && realUrls.has(normalizedModelUrl);

    // Narrow relaxation (24.08 follow-up, fourth revision — live-tested regression from revision
    // 3): LinkedIn blocks generic crawling of /in/ profile pages, so web_search's own sources
    // essentially never contain the canonical /in/ URL itself verbatim — only ADJACENT LinkedIn
    // pages (a /posts/... URL, a /company/... page) whose URL happens to embed the same vanity
    // slug, from which the model can correctly read off the real slug. Confirmed via a live
    // diagnostic call on this exact lead: Mohit Bhende's real slug ("mohit-bhende-4358b2") is
    // sitting right there in a genuine source URL
    // (linkedin.com/posts/mohit-bhende-4358b2_...), but urlVerifiedExact above still rejected it
    // because that source isn't itself the /in/ page.
    //
    // Deliberately narrow, to avoid reopening the original clean-slug-fabrication hole this whole
    // verification mechanism exists to close: the slug match only counts when the SOURCE URL
    // containing it is itself on the linkedin.com domain (any subdomain/path — posts, company,
    // regional subdomains like ar.linkedin.com all qualify). A slug that merely appears in a
    // third-party site's URL text (theorg.com, crunchbase.com, etc.) is NOT accepted here — that
    // would be indistinguishable from the model matching a name to a plausible-looking slug on an
    // unrelated page, exactly the weak evidence this feature was built to reject.
    let urlVerified = urlVerifiedExact;
    if (!urlVerified && modelUrl !== '') {
      const slug = extractLinkedinSlug(modelUrl);
      if (slug) {
        urlVerified = rawSourceUrls.some((u) => isLinkedinDomainUrl(u) && u.toLowerCase().includes(slug.toLowerCase()));
      }
    }

    // Production bug fix (24.08 follow-up, THIRD revision — found via manual verification on
    // the Karat/karat.com lead, twice now): the URL-in-sources check above only confirms a
    // LinkedIn URL is REAL — it says nothing about whether it's the RIGHT company. "Will Kim"
    // and "Eric Wei" were returned as verified Co-Founders of "Karat" — their LinkedIn URLs are
    // genuine and genuinely appeared in that call's own sources — but they're Co-Founders of
    // Karat Financial, an unrelated fintech sharing the bare word "Karat" with karat.com (this
    // lead's actual company).
    //
    // Revision 1: a code-level check that at least one source URL's domain literally equaled the
    // company website. Too blunt — most real bio sources (theorg.com, crunchbase.com, forbes
    // councils) describe an employer in TEXT, never by linking to the company's own domain, so it
    // rejected genuinely correct matches too.
    //
    // Revision 2: replaced the domain check with company_match_confirmed, the model's own
    // self-reported judgment on whether its sources connect this person to the right company.
    // Also too weak on its own — live-tested regression: the model confidently self-confirmed
    // Will Kim/Eric Wei (the WRONG "Karat") as company-matched, while the genuinely correct pair
    // came back excluded. A same-named-company collision is exactly the kind of mistake a model's
    // own unaided judgment can't be trusted to catch every time.
    //
    // Revision 3 (this one): require ALL THREE signals together, not one replacing another —
    // urlVerified (a real URL, not fabricated), companyMatchConfirmed (the model's own read of
    // its sources' content, which code alone can't see), AND domainConfirmed (a concrete,
    // code-level fact — at least one of THIS call's own sources references the company's actual
    // website domain) brought back as an independent check, not a replacement for the other two.
    // domainConfirmed stays null (doesn't block) only when companyWebsite itself is unavailable
    // to check against; once a website exists, this is a required, not optional, signal — the
    // explicit tradeoff the user asked for: a shorter, trustworthy list beats a longer one a
    // single unreliable signal (model self-report alone) can be fooled into extending.
    const companyDomain = companyWebsite ? extractDomain(companyWebsite) : null;
    const domainConfirmed =
      companyDomain === null ? null : rawSourceUrls.some((u) => u.toLowerCase().includes(companyDomain.toLowerCase()));
    const verified = urlVerified && companyMatchConfirmed && domainConfirmed !== false;

    // KNOWN LIMITATION, accepted as-is (24.08 follow-up — decided after live-testing this exact
    // three-way AND against Karat, a deliberately adversarial same-named-company case, karat.com
    // vs. the unrelated "Karat Financial"): this AND is intentionally NOT loosened further, even
    // though it produces real, reproducible false negatives — confirmed via 3 independent retry
    // attempts each (not one-off noise) for two genuinely correct people on that lead:
    //   1. No linkedin.com-domain source ever surfaces for some real people at all (their
    //      LinkedIn presence apparently isn't indexed under this query phrasing) — urlVerified
    //      can never pass for them no matter how many attempts, even with companyMatchConfirmed
    //      and domainConfirmed both true.
    //   2. Some real people's sources never literally contain the company's website domain
    //      string, even though a genuine, slug-verified LinkedIn source and a confirmed company
    //      match both exist — domainConfirmed can never pass for them.
    // Both are accepted false negatives, not bugs to keep chasing: domainConfirmed is exactly the
    // signal that caught Will Kim/Eric Wei (Karat Financial) even when the model's own
    // self-reported companyMatchConfirmed got fooled — loosening it back out to fix these two
    // false negatives would reopen that exact danger. A shorter, trustworthy list beats a longer
    // one a single weak signal can be fooled into extending.

    // TEMPORARY DEBUG LOGGING — added during the 20.08 architecture change to confirm phase 2
    // actually runs and actually verifies correctly per person; updated 24.08 (fourth revision) to
    // show the exact-vs-slug-relaxed urlVerified path separately. Remove once stable.
    this.logger.log(
      `[LPR DEBUG] phase2 "${candidate.name}" attempt ${attemptLabel}: ` +
        `raw sources=${JSON.stringify(rawSourceUrls)} ` +
        `modelUrl_raw="${modelUrl}" modelUrl_normalized="${normalizedModelUrl}" urlVerifiedExact=${urlVerifiedExact} ` +
        `urlVerified=${urlVerified} companyMatchConfirmed=${companyMatchConfirmed} ` +
        `companyDomain=${JSON.stringify(companyDomain)} domainConfirmed=${domainConfirmed} verified=${verified}`,
    );

    return { linkedinUrl: modelUrl, verified, queries };
  }
}

// The general, open-web phase-2 search prompt — unchanged wording from before the sixth
// revision, just extracted into its own function so searchPersonLinkedin can build a fresh one
// per retry attempt (and so buildCompanySitePhase2Prompt below can sit next to it for
// comparison). companyIdentifier already folds in the website when available (24.08 bug fix —
// see searchPersonLinkedin's own doc comment).
function buildGeneralPhase2Prompt(candidate: Phase1Candidate, companyIdentifier: string): string {
  return [
    `Find the LinkedIn profile URL for ${candidate.name}, ${candidate.role} at ${companyIdentifier}.`,
    '',
    'Search specifically for this person by their full name together with the company name.',
    '',
    'CRITICAL: Company names are sometimes shared by multiple unrelated companies. Before ' +
      'reporting a linkedin_url, confirm the search results actually connect this specific ' +
      'person to the company identified above (matching its name AND, if a website was ' +
      'given, its website) — not merely to a different company that happens to have a ' +
      'similar or identical name. If you cannot confirm this is the same company, or the ' +
      'person you found appears to work at a different, same-named company, report ' +
      'linkedin_url as an empty string ("") rather than a URL for the wrong company.',
    '',
    'You must also report company_match_confirmed: a true/false judgment call, based only on ' +
      'what your search actually returned. Set it to true ONLY if what you found gives you a ' +
      'real, specific basis to believe this person works at the company identified above — ' +
      'for example a search result whose text explicitly names that company (or its website) ' +
      'in connection with this person. Do not default to true, and do not set it to true just ' +
      'because you found a plausible-looking person with a matching name or role — the whole ' +
      'point of this field is to catch cases where a same-named but different company is the ' +
      'real employer. If you found nothing that specifically ties this person to this company, ' +
      'or you are genuinely unsure, set company_match_confirmed to false.',
    '',
    'CRITICAL: Only report linkedin_url if your search actually returned this specific ' +
      'person’s real LinkedIn profile page as a result. Never construct, guess, normalize, ' +
      'or "clean up" a URL from their name — copy the exact URL you saw in a search result, ' +
      'character for character. If your search does not turn up a confirmable LinkedIn ' +
      'profile URL for this specific person, report linkedin_url as an empty string ("") — ' +
      'that is a completely acceptable, correct answer. It is far better to report no URL ' +
      'than one you are not certain you actually saw.',
  ].join('\n');
}

// 24.08 follow-up, sixth revision: a second, differently targeted phase-2 prompt for
// TOP_TIER_ROLES candidates who exhaust every general attempt unverified — see
// searchPersonLinkedin's own doc comment for the Juniper Square finding that motivated this.
// Deliberately scoped to the company's OWN website (companyWebsite is required by the caller
// before this is used) rather than the open web: many startups list founders/leadership on a
// Team/About/Leadership page with a direct LinkedIn link, which the general prompt's plain
// name+company search doesn't specifically go looking for. Not a relaxation of what counts as
// verified — same PHASE2_SCHEMA, same company_match_confirmed requirement, same
// don't-construct-a-URL anti-fabrication instruction as the general prompt; only the search
// target changes.
function buildCompanySitePhase2Prompt(candidate: Phase1Candidate, company: string, companyWebsite: string): string {
  return [
    `Find the LinkedIn profile URL for ${candidate.name}, ${candidate.role} at ${company}, by ` +
      'searching the company\'s OWN website specifically — not the open web in general.',
    '',
    `Company website: ${companyWebsite}`,
    '',
    'Search specifically within this website\'s own domain (for example, a site-restricted ' +
      'search using that domain) for a Team, About, Leadership, or Founders page that lists ' +
      'this person, and check whether that page directly links to their LinkedIn profile. Many ' +
      'startups list their founders and leadership with a direct LinkedIn link right on their ' +
      'own site — that direct link, if you find it, is exactly what this search is looking for.',
    '',
    'You must also report company_match_confirmed: a true/false judgment call, based only on ' +
      'what your search actually returned. Set it to true ONLY if what you found gives you a ' +
      'real, specific basis to believe this person works at this company — a page on the ' +
      'company’s own website naming them is strong evidence. Do not default to true. If you ' +
      'found nothing on the company’s own site that specifically ties this person to this ' +
      'company, set company_match_confirmed to false.',
    '',
    'CRITICAL: Only report linkedin_url if your search actually returned a real LinkedIn link ' +
      'for this specific person from the company’s own website. Never construct, guess, ' +
      'normalize, or "clean up" a URL from their name — copy the exact URL you saw, character ' +
      'for character. If you do not find a confirmable LinkedIn link on the company’s own site ' +
      'for this specific person, report linkedin_url as an empty string ("") — that is a ' +
      'completely acceptable, correct answer.',
  ].join('\n');
}

// Extracts a bare hostname (no scheme, no "www.") from a company_website value for the
// domain-disambiguation check above — e.g. "https://www.karat.com/careers" → "karat.com".
// Returns null for a malformed/unparseable website rather than throwing, since company_website
// is free-form data from an earlier deepening step, not guaranteed to be a clean URL.
function extractDomain(website: string): string | null {
  try {
    const url = new URL(website.startsWith('http') ? website : `https://${website}`);
    return url.hostname.replace(/^www\./i, '');
  } catch {
    return null;
  }
}

// Slug-relaxed urlVerified (see searchPersonLinkedin's own comment for the full incident) — two
// small helpers, kept separate so each stays independently obvious: is this URL on the
// linkedin.com domain at all (any subdomain — ar., ru., www., none), and what's the /in/ vanity
// slug of a candidate LinkedIn profile URL, if it has one. Both return null/false rather than
// throwing on a malformed URL, same defensive style as extractDomain above.
function isLinkedinDomainUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com');
  } catch {
    return false;
  }
}

function extractLinkedinSlug(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!isLinkedinDomainUrl(url)) return null;
    const match = parsed.pathname.match(/\/in\/([^/]+)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Every web_search_call's own search queries — the "searched for X, checked Y" narrative,
// captured from the tool-call items themselves rather than assumed to be embedded in the final
// message (which Structured Outputs keeps pure JSON, no narrative mixed in). `action.queries`
// (plural) is current; `action.query` (singular) is the SDK's own documented-deprecated
// predecessor field, kept here only as a defensive fallback in case a given response only
// populates the old one. Shared by both phase 1 and every phase-2 call.
function extractSearchQueries(response: OpenAI.Responses.Response): string[] {
  return response.output
    .filter((item): item is OpenAI.Responses.ResponseFunctionWebSearch => item.type === 'web_search_call')
    .flatMap((item) => {
      if (item.action?.type !== 'search') return [];
      return item.action.queries ?? (item.action.query ? [item.action.query] : []);
    });
}

// The REAL URLs a web_search_call actually returned, as opposed to whatever the model chose to
// write into its answer — see normalizeForComparison's own comment for why these get normalized
// before comparison, never at storage time. Shared by both phase 1 (unused for verification, but
// available if ever needed) and phase 2 (where verification actually happens).
function extractRawSourceUrls(response: OpenAI.Responses.Response): string[] {
  return response.output
    .filter((item): item is OpenAI.Responses.ResponseFunctionWebSearch => item.type === 'web_search_call')
    .flatMap((item) => {
      if (item.action?.type !== 'search') return [];
      return (item.action.sources ?? []).map((s) => s.url.trim());
    });
}

// TEMPORARY DEBUG LOGGING helper — added to capture real per-call cost data (2026-08-20 follow-up:
// our API key can't read OpenAI's own usage/cost API — 403, missing api.usage.read scope — so
// this is the only way to see real token/tool-call counts). Not meant to be permanent; remove
// once the 1+N architecture's real cost is confirmed acceptable in practice. usage is optional
// on the SDK type (Response.usage?), hence the fallback branch.
function logCallCost(logger: Logger, label: string, response: OpenAI.Responses.Response): void {
  const webSearchCallCount = response.output.filter((item) => item.type === 'web_search_call').length;
  if (response.usage) {
    logger.log(
      `[LPR COST] call=${label} input_tokens=${response.usage.input_tokens} output_tokens=${response.usage.output_tokens} ` +
        `total_tokens=${response.usage.total_tokens} web_search_calls=${webSearchCallCount}`,
    );
  } else {
    logger.log(`[LPR COST] call=${label} response.usage not present on this response — web_search_calls=${webSearchCallCount}`);
  }
}

// Bug fix (found via a live diagnostic call — see the 2026-08-20 incident notes): OpenAI's
// web_search tool DOES return real linkedin.com/in/ URLs in action.sources, but appends its own
// tracking query string to every source URL it returns (?utm_source=openai, sometimes also
// ?miniProfileUrn=... on LinkedIn ones specifically) — an artifact of the citation mechanism, not
// part of the real URL. The model's own linkedin_url answer has no reason to preserve that
// tracking string, so a verbatim comparison rejected even fully honest, correct answers. Strips
// ONLY the query string and one trailing slash — both trivially cosmetic / OpenAI-injected, never
// applied to the linkedin_url actually stored (verification comparison only) — and stays
// deliberately strict on everything else (no lowercasing, no www./https normalization): the
// point is still distinguishing a URL the model actually saw from one it constructed, and
// loosening the comparison further risks accepting a plausible-but-wrong reconstruction.
function normalizeForComparison(url: string): string {
  const withoutQuery = url.split('?')[0];
  return withoutQuery.endsWith('/') ? withoutQuery.slice(0, -1) : withoutQuery;
}

// 24.08 follow-up bug fix: "Mike Liberty" (Co-Founder) and "Michael Liberty" (COO) were saved
// as two separate people — same real linkedin.com/in/mliberty profile, found via two different
// name variants that phase 1's name-string dedupe (upstream, before phase 2 runs — see its own
// comment) can't catch, since "Mike" !== "Michael" as strings. A verified linkedin_url is the
// unambiguous identity signal a name string never can be, so this dedupes by normalized URL
// first, and only falls back to name-string matching for entries that never got a verified URL
// (nothing better to compare there — same limitation the upstream pass already has, just applied
// again post-phase-2 in case an unverified duplicate slipped through with a different name
// variant). Keeps first occurrence in both cases, same convention as the upstream dedupe.
function dedupeByUrlThenName(people: LprPerson[]): LprPerson[] {
  const seenUrls = new Set<string>();
  const seenNames = new Set<string>();
  return people.filter((p) => {
    if (p.linkedin_url_verified && p.linkedin_url) {
      const key = normalizeForComparison(p.linkedin_url.trim());
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    }
    const key = p.name.trim().toLowerCase();
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });
}

// Structured Outputs guarantees response.output_text is valid JSON matching PHASE1_SCHEMA — this
// still defensively re-validates rather than trusting that blindly, but doesn't need
// parseLprPeople's markdown-fence-stripping or catch-everything leniency, since there's no
// free-text prompt-only formatting to guard against on this path.
function parsePhase1Candidates(text: string): Phase1Candidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const people = (parsed as { people?: unknown } | null)?.people;
  if (!Array.isArray(people)) return [];
  return people
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      role: typeof p.role === 'string' ? p.role : '',
      name: typeof p.name === 'string' ? p.name : '',
    }))
    .filter((p) => p.name && looksLikeFullName(p.name));
}

// 24.08 follow-up bug fix: the same Karat lead that returned 26 "people" included entries whose
// entire "name" field was bare initials ("KH", "EB", "SW", "RM", "AJ") — fragments/duplicates of
// full-name entries already in the list, not real distinct people. Rejected here at the
// parsing/validation stage rather than left to the prompt alone (the prompt says "full name",
// but nothing enforced it — same lesson as the role-enum fix: a schema/code-level constraint
// beats hoping the model follows an instruction). Requires at least two space-separated tokens
// that each look like a real name word (2+ letters, allowing internal hyphens/apostrophes for
// names like "Jean-Paul" or "O'Brien") — a lone "KH" has no space at all and is rejected
// outright; "K H" (two single-letter tokens) is rejected because neither token clears the
// 2-letter-minimum. A middle initial ("John J. Smith") still passes since two OTHER tokens
// already clear the bar.
function looksLikeFullName(name: string): boolean {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  const realTokens = tokens.filter((t) => /^[A-Za-zÀ-ÖØ-öø-ÿ]{2,}([-'][A-Za-zÀ-ÖØ-öø-ÿ]+)*$/.test(t));
  return realTokens.length >= 2;
}

// Same defensive-but-lenient-free parsing as parsePhase1Candidates, for phase 2's
// {linkedin_url, company_match_confirmed} schema. companyMatchConfirmed defaults to false on
// any parse failure or missing/malformed field (24.08 follow-up, second revision) — never a
// default of true. This is a strict-schema-required field, so a missing value here means
// something went wrong with the response itself, not a legitimate "no opinion" from the model;
// treating that the same as an explicit false keeps the fail-safe direction consistent with the
// rest of this file ("a false unverified is much safer than a false verified").
function parsePhase2Response(text: string): { linkedinUrl: string; companyMatchConfirmed: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { linkedinUrl: '', companyMatchConfirmed: false };
  }
  const obj = parsed as { linkedin_url?: unknown; company_match_confirmed?: unknown } | null;
  const url = obj?.linkedin_url;
  const confirmed = obj?.company_match_confirmed;
  return {
    linkedinUrl: typeof url === 'string' ? url : '',
    companyMatchConfirmed: confirmed === true,
  };
}
