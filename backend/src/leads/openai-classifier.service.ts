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
const PHASE2_SCHEMA = {
  type: 'object',
  properties: {
    linkedin_url: { type: 'string' },
  },
  required: ['linkedin_url'],
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

    // Dedupe by name (trimmed, case-insensitive), keeping first occurrence — phase 1's own
    // final JSON has been observed repeating the same person twice in a single response.
    const seenNames = new Set<string>();
    const candidates = parsePhase1Candidates(phase1Text).filter((c) => {
      const key = c.name.trim().toLowerCase();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });

    const toLookUp = candidates.slice(0, PHASE2_CANDIDATE_CAP);
    const overflow = candidates.slice(PHASE2_CANDIDATE_CAP);
    if (overflow.length > 0) {
      this.logger.log(`[LPR DEBUG] ${overflow.length} candidate(s) past PHASE2_CANDIDATE_CAP (${PHASE2_CANDIDATE_CAP}) — kept as name+role, unverified, no phase-2 lookup`);
    }

    // ---- Phase 2: one SEPARATE, individually forced call per candidate ----
    // Promise.allSettled, not Promise.all: one candidate's search failing (rate limit, network)
    // must not lose every other candidate's result — same "no silent failures, don't let one bad
    // item abort the run" principle used throughout this codebase's other batch flows.
    const phase2Settled = await Promise.allSettled(
      toLookUp.map((c) => this.searchPersonLinkedin(client, c, company)),
    );

    const allQueries = [...phase1Queries];
    const people: LprPerson[] = [];

    phase2Settled.forEach((settled, i) => {
      const candidate = toLookUp[i];
      if (settled.status === 'fulfilled') {
        allQueries.push(...settled.value.queries);
        people.push(
          settled.value.verified
            ? { role: candidate.role, name: candidate.name, linkedin_url: settled.value.linkedinUrl, linkedin_url_verified: true }
            : { role: candidate.role, name: candidate.name, linkedin_url: '', linkedin_url_verified: false },
        );
      } else {
        // The dedicated per-person call itself failed (rate limit, network, etc.) — keep the
        // person visible (phase 1 genuinely found them) rather than losing them because of an
        // unrelated transient failure in their specific lookup.
        this.logger.warn(`OpenAI LPR phase-2 search failed for "${candidate.name}": ${String(settled.reason)}`);
        people.push({ role: candidate.role, name: candidate.name, linkedin_url: '', linkedin_url_verified: false });
      }
    });

    for (const c of overflow) {
      people.push({ role: c.role, name: c.name, linkedin_url: '', linkedin_url_verified: false });
    }

    const reasoning = allQueries.length > 0 ? `Searched: ${allQueries.join('; ')}` : undefined;

    return { ok: true, people, raw: phase1Text, reasoning, quotaExhausted: false };
  }

  // Phase 2: ONE dedicated, forced web-search call for exactly one already-identified person —
  // never left to the model's own discretion about whether to search further (that discretion is
  // exactly what phase 1's old "two-phase in one turn" design relied on, and what didn't hold up
  // under live testing). Throws on request failure (caught by the caller's Promise.allSettled);
  // returns a verified/unverified result otherwise, using the SAME action.sources cross-check
  // built for the single-call design (normalizeForComparison below), scoped to just this call's
  // own sources.
  private async searchPersonLinkedin(
    client: OpenAI,
    candidate: Phase1Candidate,
    company: string,
  ): Promise<{ linkedinUrl: string; verified: boolean; queries: string[] }> {
    const prompt = [
      `Find the LinkedIn profile URL for ${candidate.name}, ${candidate.role} at ${company}.`,
      '',
      'Search specifically for this person by their full name together with the company name.',
      '',
      'CRITICAL: Only report linkedin_url if your search actually returned this specific ' +
        'person’s real LinkedIn profile page as a result. Never construct, guess, normalize, ' +
        'or "clean up" a URL from their name — copy the exact URL you saw in a search result, ' +
        'character for character. If your search does not turn up a confirmable LinkedIn ' +
        'profile URL for this specific person, report linkedin_url as an empty string ("") — ' +
        'that is a completely acceptable, correct answer. It is far better to report no URL ' +
        'than one you are not certain you actually saw.',
    ].join('\n');

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

    const modelUrl = parsePhase2Url(response.output_text ?? '').trim();
    const normalizedModelUrl = normalizeForComparison(modelUrl);
    const verified = modelUrl !== '' && realUrls.has(normalizedModelUrl);

    // TEMPORARY DEBUG LOGGING — added during the 20.08 architecture change to confirm phase 2
    // actually runs and actually verifies correctly per person. Remove once confirmed stable.
    this.logger.log(
      `[LPR DEBUG] phase2 "${candidate.name}": raw sources=${JSON.stringify(rawSourceUrls)} ` +
        `modelUrl_raw="${modelUrl}" modelUrl_normalized="${normalizedModelUrl}" verified=${verified}`,
    );

    return { linkedinUrl: modelUrl, verified, queries };
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
    .filter((p) => p.name);
}

// Same defensive-but-lenient-free parsing as parsePhase1Candidates, for phase 2's
// single-field {linkedin_url} schema.
function parsePhase2Url(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return '';
  }
  const url = (parsed as { linkedin_url?: unknown } | null)?.linkedin_url;
  return typeof url === 'string' ? url : '';
}
