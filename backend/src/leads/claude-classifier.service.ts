import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { LPR_ROLES, parseLprPeople, type LprSearchResult } from './gemini-classifier.service';

// Task 4 (AI-powered LPR search) — alternative provider for the manual quality-test scope
// (see gemini-classifier.service.ts's searchLeadership for the full rationale). Deliberately a
// SEPARATE provider, not a replacement for Gemini — the manager wants to compare search quality
// between the two before any real decision is made. Reads its own key
// (ANTHROPIC_API_KEY_LPR_TEST), independent of Gemini's keys.
const MODEL = 'claude-haiku-4-5-20251001';
// Same headroom rationale as Gemini's MAX_OUTPUT_TOKENS_LPR — a grounded response involves at
// least one web_search round-trip before the model produces its final JSON answer.
const MAX_TOKENS = 4096;

@Injectable()
export class ClaudeClassifierService {
  private readonly logger = new Logger(ClaudeClassifierService.name);

  private get apiKey(): string {
    const key = process.env.ANTHROPIC_API_KEY_LPR_TEST;
    if (!key) throw new Error('ANTHROPIC_API_KEY_LPR_TEST is not set');
    return key;
  }

  /**
   * Task 4 (AI-powered LPR search), manual quality-test scope only — same contract as
   * GeminiClassifierService.searchLeadership: one lead at a time, no persistence, no fallback
   * to an ungrounded answer if search isn't used (that would reopen the hallucination risk this
   * feature exists to avoid). Uses Claude's web_search tool for the same reason Gemini requires
   * google_search grounding — real search results, not a plausible-looking guess from training
   * data.
   */
  async searchLeadership(company: string, companyWebsite: string | null): Promise<LprSearchResult> {
    const prompt = [
      'You are researching the leadership of a specific company using live web search.',
      '',
      `Company name: ${company}`,
      companyWebsite ? `Company website: ${companyWebsite}` : 'Company website: not provided.',
      '',
      `Search for people who CURRENTLY hold any of these roles at this specific company: ${LPR_ROLES.join(', ')}.`,
      '',
      'For each person you find, report their role (use whichever of the roles above best ' +
        'matches what you found), full name, and LinkedIn profile URL.',
      '',
      'CRITICAL: Only include a person if your search actually found a real, specific LinkedIn ' +
        'profile for them at this company. Never guess, infer, or fabricate a name or URL from ' +
        'general knowledge or common naming patterns — if you cannot confirm a real LinkedIn ' +
        'profile via search for a given role, leave that role out of the results entirely rather ' +
        'than inventing a plausible-sounding person.',
      '',
      'Respond with ONLY a JSON array — no markdown code fences, no explanation before or after ' +
        'it. Each element: {"role": "...", "name": "...", "linkedin_url": "..."}. If you find ' +
        'nobody at all, respond with exactly: []',
    ].join('\n');

    const client = new Anthropic({ apiKey: this.apiKey });

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // web_search_20250305 (the basic variant, no beta header) — Haiku 4.5 isn't one of the
        // models the newer dynamic-filtering web_search_20260209 variant supports.
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (err) {
      const quotaExhausted = err instanceof Anthropic.RateLimitError;
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Claude LPR search request error: ${errorMessage}`);
      return { ok: false, people: [], raw: '', error: errorMessage, quotaExhausted };
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return { ok: true, people: parseLprPeople(text), raw: text, quotaExhausted: false };
  }
}
