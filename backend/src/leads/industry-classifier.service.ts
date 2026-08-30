import { Injectable, Logger } from '@nestjs/common';
import { INDUSTRY_VALUES, type Industry } from './industry';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// Same free-tier model already used for is_it classification (GeminiClassifierService.classify)
// — this is architecturally the same shape of call (plain prompt, no tools, constrained-JSON
// answer), just a bigger input (fetched website text) and a bigger enum, so there's no reason to
// pick a different model tier. Own local constant/getter rather than importing
// gemini-classifier.service.ts's — same "each classifier file owns its own small
// constants/getters" convention already used across this codebase (see e.g.
// openai-classifier.service.ts's own MODEL/apiKey).
const DEFAULT_MODEL = 'gemini-flash-latest';
const MAX_OUTPUT_TOKENS = 512;
const FETCH_TIMEOUT_MS = 8000;
// Homepage/About-Us business-description text is normally within the first few KB of visible
// copy; anything beyond this is overwhelmingly repeated nav/footer/legal boilerplate that adds
// no classification signal — capping here keeps the call cheap and the input size predictable
// regardless of how large a given company's page actually is.
const MAX_CONTENT_CHARS = 6000;

const INDUSTRY_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    industry: { type: 'STRING', enum: INDUSTRY_VALUES as unknown as string[] },
    // Always present in the schema (Gemini's JSON schema mode has no way to make a field
    // conditionally required only when industry = 'Other') — enforcement of "only really needed
    // for Other" happens in code below (classifyIndustry only ever persists this value when
    // industry === 'Other'), same "schema can't express every rule, code enforces what's left"
    // split already used elsewhere in this codebase (e.g. searchLeadership's role-mapping
    // judgment call).
    other_description: { type: 'STRING' },
  },
  required: ['industry', 'other_description'],
};

export interface IndustryClassifyResult {
  ok: boolean;
  industry: Industry | null;
  otherDescription: string | null;
  error?: string;
  // Same meaning/purpose as GeminiClassifierService.classify's own quotaExhausted — lets the
  // caller distinguish "the free tier is rate-limited right now" from any other failure.
  quotaExhausted: boolean;
}

function isQuotaExhausted(status: number, errorStatus?: string, errorMessage?: string): boolean {
  if (status === 429) return true;
  if (errorStatus === 'RESOURCE_EXHAUSTED') return true;
  return !!errorMessage && /quota|rate.?limit/i.test(errorMessage);
}

// Strips a fetched HTML page down to plain, classifiable text — same spirit as
// export-columns.ts's own plainTextCell (script/style blocks removed entirely, tags stripped,
// common entities decoded, whitespace collapsed), duplicated locally rather than imported since
// that function isn't exported and this file has no reason to create a shared-utils dependency
// for one small regex helper — consistent with this codebase's existing per-file-helper style.
function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Shared, provider-agnostic building blocks — exported for reuse by
// openai-industry-classifier.service.ts (24.08 follow-up: OpenAI became the active provider,
// Gemini kept available — see that file's own doc comment). What we ask the model and how the
// website gets fetched/truncated must behave identically regardless of which provider answers,
// so these live here once rather than being duplicated per provider (unlike LPR's per-provider
// prompt wording, which was deliberately allowed to diverge since Gemini/Claude's LPR paths
// stayed as their original, un-refactored ephemeral-test implementations — Industry classify has
// no such legacy-implementation constraint, both providers were built together this round).

// Never throws — a network error, timeout, or non-2xx response all resolve to null (fetch
// couldn't happen at all), same as CompanyLinkedinService.extractLinkedinUrls's own contract,
// except this returns null rather than an empty array since "couldn't fetch" and "fetched fine
// but genuinely empty" are usefully distinct failure messages for the manager triggering this
// by hand (see classifyIndustry's two separate error strings below).
export async function fetchWebsiteText(companyWebsite: string): Promise<string | null> {
  let html: string;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(companyWebsite, { signal: controller.signal });
      if (!res.ok) return null;
      html = await res.text();
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }

  return htmlToPlainText(html).slice(0, MAX_CONTENT_CHARS);
}

// 30.08 follow-up — the 5 apollo_* fields captured on job_leads alongside organization_id
// resolution (apollo-classifier.service.ts's resolveOrganization/persistOrganization). Each is
// independently optional, same nullability as the DB columns themselves — a lead can have some
// of these set and not others.
export interface ApolloIndustryInput {
  apolloIndustry: string | null;
  apolloIndustries: string[] | null;
  apolloSecondaryIndustries: string[] | null;
  apolloKeywords: string[] | null;
  apolloShortDescription: string | null;
}

// Builds a compact, labeled text block from whichever apollo_* fields are present, for use as
// classifyIndustry's model input INSTEAD OF fetchWebsiteText's scraped HTML — cheaper (already
// short, curated text vs. raw page markup) and, per real testing (DriveWealth, Sniffspot,
// 10a Labs, Keeper), often names the target customer explicitly ("banks, fintechs, and consumer
// brands", "dog owners", "frontier AI labs, Fortune 10 companies") in short_description alone.
// Returns null — same "nothing usable" contract as fetchWebsiteText returning null — when none of
// the 5 fields are present, which is exactly the signal callers use to fall back to the existing
// website-fetch path unchanged (see classifyIndustry in this file and in
// openai-industry-classifier.service.ts). Only ever changes what TEXT gets classified — the
// instructions in buildIndustryPrompt (target-audience-not-product rule, "Other"-preference rule,
// Professional-Services tightening rule) are untouched by this function and by every call site
// that uses it.
export function buildApolloIndustryInputText(apollo: ApolloIndustryInput): string | null {
  const lines: string[] = [];
  if (apollo.apolloIndustry) lines.push(`Apollo industry: ${apollo.apolloIndustry}`);
  if (apollo.apolloIndustries && apollo.apolloIndustries.length > 0) {
    lines.push(`Related industries: ${apollo.apolloIndustries.join(', ')}`);
  }
  if (apollo.apolloSecondaryIndustries && apollo.apolloSecondaryIndustries.length > 0) {
    lines.push(`Secondary industries: ${apollo.apolloSecondaryIndustries.join(', ')}`);
  }
  if (apollo.apolloKeywords && apollo.apolloKeywords.length > 0) {
    lines.push(`Keywords: ${apollo.apolloKeywords.join(', ')}`);
  }
  if (apollo.apolloShortDescription) lines.push(`Description: ${apollo.apolloShortDescription}`);
  return lines.length > 0 ? lines.join('\n') : null;
}

// 30.08 follow-up, second change — which source produced `inputText`, so buildIndustryPrompt can
// label it accurately (see the function's own comment). Passed explicitly by the caller rather
// than inferred from the text's shape, per this task's own instruction — classifyIndustry already
// knows exactly which branch it took (buildApolloIndustryInputText vs. fetchWebsiteText), so there
// is a real, unambiguous answer to pass through instead of guessing from content.
export type IndustryInputSource = 'website' | 'apollo';

export function buildIndustryPrompt(company: string, inputText: string, inputSource: IndustryInputSource): string {
  return [
    'You are classifying which INDUSTRY a company operates in, based on the text of its own ' +
      'website below.',
    '',
    `Company name: ${company}`,
    '',
    'CRITICAL RULE: classify the industry/vertical the company actually operates IN — not what ' +
      'its product technically is. A company that sells CRM software for the energy sector is ' +
      '"Energy," not "Software Development," even though its product is software. A healthcare ' +
      'company with an internal software product is still "Healthcare." Only classify a company ' +
      'as "Software Development" when building and selling software IS the company’s own ' +
      'core business — its product is general-purpose software sold across industries, not a ' +
      'tool built for one specific vertical’s operations.',
    '',
    `Choose exactly one industry from this fixed list: ${INDUSTRY_VALUES.join(', ')}.`,
    '',
    'CRITICAL RULE ON "Other": a plausible-sounding but imprecise category is WORSE than an ' +
      'honest "Other." If the company’s actual core business does not clearly match what a ' +
      'category genuinely means, do not force it into the closest-sounding label just because ' +
      'it resembles that category on the surface — choose "Other" and describe the real ' +
      'business accurately instead. Two real, verified examples of this exact mistake: ' +
      '(1) Sniffspot (sniffspot.com) is a peer-to-peer marketplace where dog owners rent ' +
      'private outdoor space by the hour to use as dog parks — this was wrongly classified ' +
      '"Hospitality & Travel" because it superficially resembles booking/renting a space, but ' +
      'that category means lodging/travel for PEOPLE, not this; it should have been "Other" ' +
      'with a description like "peer-to-peer marketplace for renting private outdoor space for ' +
      'dogs." (2) 10a Labs (10alabs.com) does applied AI-security research — red-teaming, ' +
      'threat intelligence, and model evaluations for AI systems — this was wrongly classified ' +
      '"Software Development" just because the work involves software/AI systems, but the ' +
      'company’s actual business is specialized security research, not building/selling a ' +
      'software product; it should have been "Other" with a description like "AI security ' +
      'research and red-teaming." Only in the "Other" case, fill other_description with a ' +
      'short, one-sentence, plain-language explanation of what the company actually does. If ' +
      'you chose anything other than "Other", leave other_description as an empty string.',
    '',
    'CRITICAL RULE ON "Professional Services & Consulting": this category means businesses ' +
      'whose product IS billable human expertise or labor — consulting firms, agencies, ' +
      'staffing firms, law firms — not software or SaaS products, even when humans are ' +
      'involved somewhere in delivering them. Real verified example of this exact mistake: ' +
      'Keeper (keepertax.com), an AI-plus-human-backed tax filing SaaS for freelancers, was ' +
      'wrongly classified "Professional Services & Consulting" — it should have been "Banking ' +
      '& Financial Services," because Keeper’s actual product is financial/tax SOFTWARE, not ' +
      'human expert labor sold directly as the offering. Before choosing "Professional ' +
      'Services & Consulting," confirm the company’s core offering genuinely IS paid human ' +
      'expertise, not a software product that happens to have some human review built in.',
    '',
    inputSource === 'apollo' ? 'Apollo company data:' : 'Website content:',
    inputText,
  ].join('\n');
}

export function parseIndustryResponse(text: string): { industry: Industry; otherDescription: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const obj = parsed as { industry?: unknown; other_description?: unknown } | null;
  const industry = obj?.industry;
  if (typeof industry !== 'string' || !(INDUSTRY_VALUES as readonly string[]).includes(industry)) {
    return null;
  }
  const otherDescription = typeof obj?.other_description === 'string' ? obj.other_description.trim() : '';
  return { industry: industry as Industry, otherDescription };
}

/**
 * Industry classification (24.08 follow-up, per the 19.08 call) — classifies the COMPANY's
 * industry/vertical from its own website content, NOT its product. Deliberately NOT a live
 * search/tool-use call like LPR — this is text classification of already-visible content, so it
 * doesn't need any of that machinery: one plain fetch of company_website (reusing the same
 * fetch-with-timeout pattern as CompanyLinkedinService.extractLinkedinUrls, not TabDeepening),
 * one Gemini call with schema-constrained JSON output, done.
 *
 * NOT the active provider as of the second 24.08 follow-up (kept in place, not deleted) — Gemini
 * started throwing "high demand" errors during manual testing, so OpenaiIndustryClassifierService
 * (own file) is LeadsService.classifyIndustry's default now, same "OpenAI became the default,
 * Gemini/Claude stayed selectable" pattern LPR already went through. Still reachable via
 * ?provider=gemini. Free-tier cost is the whole reason to come back to this path once Gemini's
 * demand issue is confirmed resolved — see LeadsService.classifyIndustry's own comment for the
 * explicit "don't let this quietly become permanent" flag.
 */
@Injectable()
export class IndustryClassifierService {
  private readonly logger = new Logger(IndustryClassifierService.name);

  // GEMINI_API_KEY (the same free-tier key already used for is_it classification) — NOT
  // GEMINI_API_KEY_LPR_TEST. This call attaches no google_search tool, so it never hits the
  // grounding-billing issue that key exists to work around; there's no reason to use a separate
  // credential for a plain classification call.
  private get apiKey(): string {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set');
    return key;
  }

  private get model(): string {
    return process.env.GEMINI_MODEL || DEFAULT_MODEL;
  }

  // `apolloInput` (30.08 follow-up) is optional so every existing call site that doesn't pass it
  // behaves EXACTLY as before this revision — see the else branch below, byte-for-byte the same
  // sequence of checks/calls this method already had. When present and at least one of its 5
  // fields is non-null, that becomes the model's input INSTEAD OF fetchWebsiteText — cheaper,
  // curated text that (per real testing) often names the target customer explicitly. When absent,
  // or present but empty (all 5 fields null — e.g. organization_id resolution never ran, or ran
  // and found nothing), falls back to the original website-fetch path unchanged.
  async classifyIndustry(
    company: string,
    companyWebsite: string | null,
    apolloInput?: ApolloIndustryInput,
  ): Promise<IndustryClassifyResult> {
    const apolloText = apolloInput ? buildApolloIndustryInputText(apolloInput) : null;

    let inputText: string;
    let inputSource: IndustryInputSource;
    if (apolloText !== null) {
      inputText = apolloText;
      inputSource = 'apollo';
    } else {
      inputSource = 'website';
      if (!companyWebsite) {
        return {
          ok: false,
          industry: null,
          otherDescription: null,
          error: 'This lead has no company website on file — nothing to classify from.',
          quotaExhausted: false,
        };
      }

      const websiteText = await fetchWebsiteText(companyWebsite);
      if (websiteText === null) {
        return {
          ok: false,
          industry: null,
          otherDescription: null,
          error: 'Could not fetch the company website (unreachable, timed out, or returned an error).',
          quotaExhausted: false,
        };
      }
      if (websiteText.length === 0) {
        return {
          ok: false,
          industry: null,
          otherDescription: null,
          error: 'The company website returned no readable text content.',
          quotaExhausted: false,
        };
      }
      inputText = websiteText;
    }

    const prompt = buildIndustryPrompt(company, inputText, inputSource);

    let data: unknown;
    try {
      const res = await fetch(`${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            // No tools attached on this call, so (unlike LPR's grounded search)
            // constrained-JSON decoding isn't blocked — see this file's own top-of-file comment.
            responseMimeType: 'application/json',
            responseSchema: INDUSTRY_RESPONSE_SCHEMA,
          },
        }),
      });
      data = await res.json();
      const error = (data as { error?: { status?: string; message?: string } })?.error;
      if (!res.ok || error) {
        const quotaExhausted = isQuotaExhausted(res.status, error?.status, error?.message);
        this.logger.warn(`Gemini industry classify failed (HTTP ${res.status}): ${error?.message ?? 'unknown error'}`);
        return { ok: false, industry: null, otherDescription: null, error: error?.message ?? `HTTP ${res.status}`, quotaExhausted };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Gemini industry classify request error: ${message}`);
      return { ok: false, industry: null, otherDescription: null, error: message, quotaExhausted: false };
    }

    const candidate = (data as { candidates?: { content?: { parts?: { text?: string }[] } }[] })?.candidates?.[0];
    const candidateText = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

    const parsed = parseIndustryResponse(candidateText);
    if (!parsed) {
      this.logger.warn(`Gemini industry classify: unparseable/invalid response ${JSON.stringify(candidateText).slice(0, 500)}`);
      return {
        ok: false,
        industry: null,
        otherDescription: null,
        error: 'Model returned an unparseable or invalid response.',
        quotaExhausted: false,
      };
    }

    // industry_other_description is only ever meaningful when industry = 'Other' — discarded
    // here even if the model filled it in anyway, same code-level enforcement of a conditional
    // rule the schema itself can't express (see INDUSTRY_RESPONSE_SCHEMA's own comment).
    return {
      ok: true,
      industry: parsed.industry,
      otherDescription: parsed.industry === 'Other' ? parsed.otherDescription || null : null,
      quotaExhausted: false,
    };
  }
}
