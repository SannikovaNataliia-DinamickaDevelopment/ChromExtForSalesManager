import { Injectable, Logger } from '@nestjs/common';
import OpenAI, { RateLimitError } from 'openai';
import { INDUSTRY_VALUES } from './industry';
import {
  buildApolloIndustryInputText,
  buildIndustryPrompt,
  fetchWebsiteText,
  parseIndustryResponse,
  type ApolloIndustryInput,
  type IndustryClassifyResult,
  type IndustryInputSource,
} from './industry-classifier.service';

// Same model already used for DM search (openai-classifier.service.ts) — gpt-4.1-mini. That
// choice was specifically about being the cheapest model supporting the web_search TOOL; this
// call attaches no tool at all (plain text in, structured enum out — even simpler than DM), so
// nothing here actually requires that model specifically. Kept the same anyway, for now, to avoid
// reasoning about a third pricing/quality tier while this is still a manual per-lead test — see
// LeadsService.classifyIndustry's own comment on revisiting the provider/cost question before
// this runs automatically across the full database.
const MODEL = 'gpt-4.1-mini';
const MAX_OUTPUT_TOKENS = 512;

// Structured Outputs requires an OBJECT at the schema root (same constraint noted in
// openai-classifier.service.ts's own PHASE1_SCHEMA comment) — {industry, other_description} is
// already object-shaped, so no wrapper needed here, unlike LPR's {people: [...]} array case.
// additionalProperties: false and a full `required` list, same strict-schema convention as every
// other OpenAI Structured Outputs schema in this codebase.
const INDUSTRY_SCHEMA = {
  type: 'object',
  properties: {
    industry: { type: 'string', enum: INDUSTRY_VALUES as unknown as string[] },
    // Always required by the schema even though it's only ever meaningful when
    // industry === 'Other' — same code-level (not schema-level) enforcement of that conditional
    // rule as IndustryClassifierService's own Gemini path (see its INDUSTRY_RESPONSE_SCHEMA
    // comment); OpenAI's strict json_schema mode has the same "no conditional required" gap
    // Gemini's responseSchema does.
    other_description: { type: 'string' },
  },
  required: ['industry', 'other_description'],
  additionalProperties: false,
};

/**
 * OpenAI counterpart to IndustryClassifierService (industry-classifier.service.ts) — same
 * classifyIndustry(company, companyWebsite) contract, same shared fetch/prompt/parse helpers
 * (imported from that file, not duplicated — see its own top-of-file comment on why the
 * provider-agnostic pieces live there once). Deliberately NO web_search tool: this call is pure
 * text classification of content already fetched by fetchWebsiteText, so there's nothing for a
 * search tool to do — even simpler than DM's forced 1+N web_search architecture.
 *
 * The ACTIVE provider as of the second 24.08 follow-up (Gemini started throwing "high demand"
 * errors during manual testing) — see IndustryClassifierService's own doc comment for the full
 * context and the explicit flag not to let this quietly become the permanent choice without a
 * cost conversation once this runs at full-database scale.
 */
@Injectable()
export class OpenaiIndustryClassifierService {
  private readonly logger = new Logger(OpenaiIndustryClassifierService.name);

  private get apiKey(): string {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not set');
    return key;
  }

  // Same optional-third-param, same fallback contract as IndustryClassifierService's Gemini
  // path (industry-classifier.service.ts) — see that file's own comment on classifyIndustry for
  // the full reasoning. Kept identical between the two providers deliberately, per this task's
  // own "consistently, using the shared functions" requirement.
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
    const client = new OpenAI({ apiKey: this.apiKey });

    let response: OpenAI.Responses.Response;
    try {
      response = await client.responses.create({
        model: MODEL,
        input: prompt,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        // No tools field at all — plain text in, structured enum out, per this file's own
        // top-of-file comment.
        text: {
          format: {
            type: 'json_schema',
            name: 'industry_classification',
            strict: true,
            schema: INDUSTRY_SCHEMA,
          },
        },
      });
    } catch (err) {
      const quotaExhausted = err instanceof RateLimitError;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`OpenAI industry classify request error: ${message}`);
      return { ok: false, industry: null, otherDescription: null, error: message, quotaExhausted };
    }

    const parsed = parseIndustryResponse(response.output_text ?? '');
    if (!parsed) {
      this.logger.warn(`OpenAI industry classify: unparseable/invalid response ${JSON.stringify(response.output_text).slice(0, 500)}`);
      return {
        ok: false,
        industry: null,
        otherDescription: null,
        error: 'Model returned an unparseable or invalid response.',
        quotaExhausted: false,
      };
    }

    // industry_other_description is only ever meaningful when industry = 'Other' — same
    // code-level enforcement as IndustryClassifierService's own Gemini path.
    return {
      ok: true,
      industry: parsed.industry,
      otherDescription: parsed.industry === 'Other' ? parsed.otherDescription || null : null,
      quotaExhausted: false,
    };
  }
}
