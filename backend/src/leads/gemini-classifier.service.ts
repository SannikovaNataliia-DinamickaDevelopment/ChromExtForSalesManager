import { Injectable, Logger } from '@nestjs/common';
import type { LeadIsIt } from './lead-is-it';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// Verified against the live free-tier key (2026-07-27): gemini-2.0-flash and gemini-2.5-flash
// are 429/404 on this key's tier; "gemini-flash-latest" is Google's alias for whatever current
// flash model the key does have free-tier access to (currently resolves to gemini-3.6-flash),
// so it stays valid without a code change if that changes again.
const DEFAULT_MODEL = 'gemini-flash-latest';
// Newer flash models spend hidden "thinking" tokens even on trivial prompts (observed ~160
// tokens for a one-word answer) — too low a cap here truncates the response before the visible
// answer is produced (finishReason MAX_TOKENS, empty text), which reads as unparseable.
const MAX_OUTPUT_TOKENS = 1024;

export interface ClassifyResult {
  outcome: LeadIsIt;
  // True when the failure looks like the free-tier quota is exhausted (HTTP 429,
  // RESOURCE_EXHAUSTED, or a quota-shaped message) rather than a one-off blip — the caller
  // (extension's classify loop) uses this to stop hammering the API instead of grinding
  // through every remaining lead for another guaranteed failure.
  quotaExhausted: boolean;
}

function isQuotaExhausted(status: number, errorStatus?: string, errorMessage?: string): boolean {
  if (status === 429) return true;
  if (errorStatus === 'RESOURCE_EXHAUSTED') return true;
  return !!errorMessage && /quota|rate.?limit/i.test(errorMessage);
}

@Injectable()
export class GeminiClassifierService {
  private readonly logger = new Logger(GeminiClassifierService.name);

  private get apiKey(): string {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set');
    return key;
  }

  private get model(): string {
    return process.env.GEMINI_MODEL || DEFAULT_MODEL;
  }

  /**
   * CLAUDE.md scope C: broad, shallow IT/not-IT classification only — no Remote filter, no
   * deep analysis. Rate-limit aware (NFR-12/13): quota errors, network errors, and unparseable
   * answers all resolve to 'unprocessed' instead of throwing, so the caller can safely retry
   * later rather than crash or mis-tag a lead.
   */
  async classify(title: string, description: string): Promise<ClassifyResult> {
    const prompt =
      'Does this job posting broadly belong to the IT / software / technology field (including ' +
      'tech roles that could be done remotely)? Answer with exactly one word, either "it" or ' +
      '"not_it" — nothing else, no punctuation, no explanation.\n\n' +
      `Title: ${title}\n\nDescription: ${description.slice(0, 4000)}`;

    let data: unknown;
    try {
      const res = await fetch(`${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
      });
      data = await res.json();
      const error = (data as { error?: { status?: string; message?: string } })?.error;
      if (!res.ok || error) {
        const quotaExhausted = isQuotaExhausted(res.status, error?.status, error?.message);
        this.logger.warn(`Gemini classify failed (HTTP ${res.status}): ${error?.message ?? 'unknown error'}`);
        return { outcome: 'unprocessed', quotaExhausted };
      }
    } catch (err) {
      this.logger.warn(`Gemini classify request error: ${err instanceof Error ? err.message : String(err)}`);
      return { outcome: 'unprocessed', quotaExhausted: false };
    }

    const text = (data as { candidates?: { content?: { parts?: { text?: string }[] } }[] })?.candidates?.[0]
      ?.content?.parts?.[0]?.text;
    const answer = typeof text === 'string' ? text.trim().toLowerCase().replace(/[^a-z_]/g, '') : '';
    if (answer === 'it') return { outcome: 'it', quotaExhausted: false };
    if (answer === 'not_it') return { outcome: 'not_it', quotaExhausted: false };

    this.logger.warn(`Gemini classify: unparseable answer ${JSON.stringify(text)}`);
    return { outcome: 'unprocessed', quotaExhausted: false };
  }
}
