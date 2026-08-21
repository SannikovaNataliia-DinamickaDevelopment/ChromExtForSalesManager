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

// Task 4 (AI-powered LPR search) — manual quality-test scope only, per the request: one lead
// at a time, no batch run, nothing persisted. Mariia's own list from the 14.08 call.
// Exported so claude-classifier.service.ts's searchLeadership can share the exact same role
// list and prompt wording — the two providers are meant to be judged on search quality, not on
// wording differences between their prompts.
export const LPR_ROLES = [
  'CEO', 'CTO', 'Founder', 'Co-Founder', 'Owner', 'Co-Owner',
  'VP of Engineering', 'VP of Technology', 'CIO', 'COO', 'General Manager',
];

// A rough hidden-"thinking" + grounding-tool-call budget on top of the visible answer — a
// grounded response involves at least one search round-trip before the model even starts
// producing the JSON array, so this needs more headroom than the plain classify() call above.
const MAX_OUTPUT_TOKENS_LPR = 4096;

export interface LprPerson {
  role: string;
  name: string;
  linkedin_url: string;
  // 20.08 follow-up bug fix: OpenAI's model was writing a "clean" firstnamelastname URL slug
  // instead of the person's real (usually hyphenated/numeric-suffixed) LinkedIn URL — the name
  // and role were correct, only the URL was fabricated. Only OpenaiClassifierService populates
  // this (cross-checked against the Responses API's own actual web_search_call.action.sources —
  // real returned URLs, not anything the model wrote); Gemini/Claude leave it undefined since
  // neither implements that cross-check. undefined = not checked (Gemini/Claude, or data saved
  // before this fix); true = linkedin_url matched a real search result verbatim; false = it
  // didn't, and linkedin_url has been blanked to '' rather than shown as a possibly-fake link —
  // see openai-classifier.service.ts's own doc comment for why blank-not-fabricated beats
  // dropping the person entirely.
  linkedin_url_verified?: boolean;
}

export interface LprSearchResult {
  ok: boolean;
  people: LprPerson[];
  // Always populated when ok is true — the whole point of this manual test is judging
  // quality/hallucination risk from the model's own words, not just the (possibly empty or
  // malformed) parsed array.
  raw: string;
  // 20.08 follow-up: the model's own narrative/search-query text, captured SEPARATELY from the
  // structured `people` result — persisted as job_leads.lpr_reasoning (see leads.service.ts's
  // lprSearch). Only OpenaiClassifierService populates this (its Structured Outputs final
  // message is pure JSON, so the narrative has to come from elsewhere — see that file's own
  // doc comment); Gemini/Claude leave it undefined since their unchanged ephemeral-test prompts
  // still mix everything into `raw` — lprSearch() falls back to `raw` for those two rather than
  // leaving the persisted reasoning column empty.
  reasoning?: string;
  error?: string;
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

  // Task 4 (AI-powered LPR search) manual test scope — deliberately a SEPARATE key from
  // classify()'s GEMINI_API_KEY above, not shared. The grounded google_search tool call
  // 429'd immediately on the classify key (evidence points to that project having no billing
  // linked — see gemini-classifier.service.ts's investigation in the DI-2966 history), so
  // this points at a second, independent key while that gets sorted out, without risking any
  // change to the already-working classification feature's own key/quota.
  private get lprApiKey(): string {
    const key = process.env.GEMINI_API_KEY_LPR_TEST;
    if (!key) throw new Error('GEMINI_API_KEY_LPR_TEST is not set');
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

  /**
   * Task 4 (AI-powered LPR search), manual quality-test scope only — one lead at a time, no
   * batch run, no persistence (see leads.service.ts's lprSearch). Requires Google Search
   * grounding (tools: google_search below) since the whole point is real search results, not
   * the model guessing a plausible-looking name/URL from training data — a plain, ungrounded
   * call is exactly the hallucination risk this feature exists to avoid, so this deliberately
   * does NOT fall back to one if grounding fails; the caller sees the real error instead.
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

    let data: unknown;
    try {
      const res = await fetch(`${API_BASE}/${this.model}:generateContent?key=${this.lprApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS_LPR },
          // responseMimeType: 'application/json' is deliberately NOT set here — Gemini's
          // constrained-JSON decoding mode is incompatible with tool use (grounding requires
          // a search round-trip before the model can produce its final answer), so this
          // relies on the prompt's own instruction and parses leniently below instead.
          tools: [{ google_search: {} }],
        }),
      });
      data = await res.json();
      const error = (data as { error?: { status?: string; message?: string } })?.error;
      if (!res.ok || error) {
        const quotaExhausted = isQuotaExhausted(res.status, error?.status, error?.message);
        this.logger.warn(`Gemini LPR search failed (HTTP ${res.status}): ${error?.message ?? 'unknown error'}`);
        return { ok: false, people: [], raw: '', error: error?.message ?? `HTTP ${res.status}`, quotaExhausted };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Gemini LPR search request error: ${message}`);
      return { ok: false, people: [], raw: '', error: message, quotaExhausted: false };
    }

    const candidate = (data as { candidates?: { content?: { parts?: { text?: string }[] } }[] })?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

    return { ok: true, people: parseLprPeople(text), raw: text, quotaExhausted: false };
  }
}

// Grounded responses occasionally wrap the JSON in a markdown code fence despite being asked
// not to — stripped defensively rather than failing the whole parse over it. Any entry missing
// a name or linkedin_url is dropped rather than shown as a half-populated result; the raw text
// (always returned alongside this) is what a caller inspects to see what actually happened.
// Exported for reuse by claude-classifier.service.ts — same JSON-array contract, same lenient
// parse, regardless of which model produced the text.
export function parseLprPeople(text: string): LprPerson[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      role: typeof p.role === 'string' ? p.role : '',
      name: typeof p.name === 'string' ? p.name : '',
      linkedin_url: typeof p.linkedin_url === 'string' ? p.linkedin_url : '',
    }))
    .filter((p) => p.name && p.linkedin_url);
}
