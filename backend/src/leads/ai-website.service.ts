import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import OpenAI, { RateLimitError } from 'openai';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { job_leads } from '../db/schema';
import { isBlocked, nameTokens, registrableDomain } from './company-website-from-description';

// AI company-website finder (Indeed V1, 06.10 meeting): Indeed postings carry a company NAME but
// no website, and the downstream pipeline (Apollo industry + DM search) needs a website. Clicking
// through every lead by hand was ruled out ("bottleneck") — the website is found automatically,
// and only uncertain results are left flagged for a human.
//
// Per company (not per lead): one OpenAI Responses call with the web_search tool (a real search,
// never a guess from training data — same rule as openai-classifier.service.ts), then a FREE
// check: fetch the site and look for the company name on it. Confident + loads + mentions the
// company → 'ai_verified' (no flag); anything else with a website → 'ai_guess' (flagged "!",
// gated before Apollo exactly like 'description_guess'); nothing found → note only.
//
// Budget is tiny (06.10: ~$7 of OpenAI credit), so: an explicit manager click per batch with a
// cost estimate in the dashboard, a per-run company cap, companies that already have a reliable
// website reused for free, and AI_WEBSITE_MOCK=true for trying the flow with no API call at all.
// Automatic triggering after deepening is opt-in (AI_WEBSITE_AUTO=true — see enqueueAuto).

const MODEL = 'gpt-4.1-mini';
const MAX_OUTPUT_TOKENS = 700;
const VERIFY_TIMEOUT_MS = 8000;
const BETWEEN_CALLS_MS = 1000;
const DESCRIPTION_EXCERPT_CHARS = 1500;

// Max distinct companies (= OpenAI calls) one run may spend on.
export const AI_WEBSITE_RUN_CAP = 40;
// Planning figure for the dashboard's confirmation dialog. First approved live test (09.10, 3
// companies): ~8.2k input / ~100 output tokens + 1 web search call each; the OpenAI balance went
// $6.96 -> $6.93, i.e. ~$0.01 per company. Kept slightly higher until the balance settles.
export const AI_WEBSITE_EST_COST_PER_COMPANY_USD = 0.015;

// Prefix of company_website_note for "searched, nothing found" — such leads are skipped by later
// runs so the same dead end isn't paid for twice.
export const AI_NOT_FOUND_NOTE_PREFIX = 'AI: no website found';

type Confidence = 'high' | 'medium' | 'low';

interface AiAnswer {
  website: string;
  confidence: Confidence;
  is_recruiting_agency: boolean;
  reasoning: string;
}

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    website: { type: 'string', description: "The company's own main website (homepage URL or domain); empty string if not identified." },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    is_recruiting_agency: { type: 'boolean', description: 'True if the poster is a recruiting/staffing agency rather than the hiring company.' },
    reasoning: { type: 'string', description: 'One or two sentences: how the website was identified.' },
  },
  required: ['website', 'confidence', 'is_recruiting_agency', 'reasoning'],
} as const;

export interface AiWebsiteStatus {
  running: boolean;
  mock: boolean;
  totalCompanies: number;
  processedCompanies: number;
  leadsTotal: number;
  verified: number; // companies saved as ai_verified
  guessed: number; // companies saved as ai_guess (flagged)
  notFound: number;
  reused: number; // companies filled from another lead's reliable website — no API call
  failed: number;
  skippedIneligible: number; // leads: no company name / already have a reliable website / known dead end
  skippedCap: number; // leads of companies beyond AI_WEBSITE_RUN_CAP
  quotaExhausted: boolean;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

const IDLE_STATUS: AiWebsiteStatus = {
  running: false,
  mock: false,
  totalCompanies: 0,
  processedCompanies: 0,
  leadsTotal: 0,
  verified: 0,
  guessed: 0,
  notFound: 0,
  reused: 0,
  failed: 0,
  skippedIneligible: 0,
  skippedCap: 0,
  quotaExhausted: false,
  lastError: null,
  startedAt: null,
  finishedAt: null,
};

interface CompanyGroup {
  key: string;
  company: string;
  leadIds: string[];
  jobTitle: string | null;
  location: string | null;
  countryHost: string | null;
  description: string | null;
  hintDomain: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same normalization the dashboard uses to group "leads of the same company".
function companyKey(company: string): string {
  return company.trim().toLowerCase();
}

function domainFromAnswer(website: string): string | null {
  const raw = website.trim();
  if (!raw) return null;
  try {
    const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
    const domain = registrableDomain(host);
    return domain && !isBlocked(domain) ? domain : null;
  } catch {
    return null;
  }
}

function plainExcerpt(description: string | null): string {
  return (description ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DESCRIPTION_EXCERPT_CHARS);
}

// Domain marketplaces / parking pages — a domain that redirects here is for sale, not a company
// site. Live 09.10: the AI returned "hudsonstudio.com" with high confidence; it redirects to
// hugedomains.com.
const PARKING_HOSTS = ['hugedomains.com', 'sedo.com', 'dan.com', 'afternic.com', 'godaddy.com', 'bodis.com', 'parkingcrew.net', 'above.com', 'undeveloped.com', 'squadhelp.com', 'atom.com'];
const PARKING_TEXT = /(this domain (name )?(is|may be) for sale|buy this domain|domain is for sale|make an offer on this domain|the domain name .{0,40} is for sale)/i;

// A regular browser's request headers — some company sites answer anything else with 403/404
// (live 09.10: nttdata.com returned 404 to a bot-style User-Agent and 200 to a browser one).
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export interface SiteCheck {
  loaded: boolean;
  mentionsCompany: boolean;
  // Not a real company site: a parked/for-sale domain, or one that doesn't resolve in DNS at all
  // (live 09.10: the AI's "hudsonstudio.com" — ENOTFOUND here, a hugedomains.com sale page in a
  // browser). Either way the AI's answer is wrong.
  parked: boolean;
}

// Free check (no API): does the site load, is it a real site (not a parked domain for sale), and
// does it mention the company?
// One retry when the site didn't answer at all — live 09.10 the very same domain alternated between
// a clean redirect and a failed connection from one attempt to the next.
export async function verifySite(domain: string, company: string): Promise<SiteCheck> {
  const first = await verifySiteOnce(domain, company);
  if (first.loaded || first.parked) return first;
  await sleep(1000);
  return verifySiteOnce(domain, company);
}

async function verifySiteOnce(domain: string, company: string): Promise<SiteCheck> {
  const isParkingHost = (host: string) => PARKING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  // Redirects followed by hand so every hop can be checked: live 09.10, "hudsonstudio.com"
  // redirected to www.hugedomains.com, which itself didn't resolve on this network — with
  // automatic redirects the check only saw a network error, never the for-sale redirect.
  let url = `https://${domain}`;
  try {
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS), headers: BROWSER_HEADERS });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, url);
        if (isParkingHost(next.hostname.toLowerCase())) return { loaded: true, mentionsCompany: false, parked: true };
        url = next.toString();
        continue;
      }
      if (!res.ok) return { loaded: false, mentionsCompany: false, parked: false };
      const html = (await res.text()).slice(0, 400_000).toLowerCase();
      if (PARKING_TEXT.test(html)) return { loaded: true, mentionsCompany: false, parked: true };
      const tokens = nameTokens(company);
      const label = domain.split('.')[0].replace(/-/g, '');
      const mentionsCompany =
        (tokens.length > 0 && tokens.every((t) => html.includes(t))) || (label.length >= 4 && html.includes(label));
      return { loaded: true, mentionsCompany, parked: false };
    }
    return { loaded: false, mentionsCompany: false, parked: false };
  } catch (err) {
    // The AI's own domain not resolving at all = it doesn't exist (a later hop failing doesn't count).
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    const failedHost = (() => {
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })();
    return { loaded: false, mentionsCompany: false, parked: code === 'ENOTFOUND' && failedHost === domain };
  }
}

function siteCheckText(check: SiteCheck): string {
  if (check.parked) return 'domain does not exist or is parked / for sale';
  if (!check.loaded) return 'site did not load';
  return check.mentionsCompany ? 'site loads and mentions the company' : 'site loads but does not mention the company';
}

@Injectable()
export class AiWebsiteService {
  private readonly logger = new Logger(AiWebsiteService.name);
  private state: AiWebsiteStatus = { ...IDLE_STATUS };
  private autoQueue = new Set<string>();

  constructor(@Inject(DB) private readonly db: Db) {}

  getStatus(): AiWebsiteStatus {
    return { ...this.state };
  }

  private get isMock(): boolean {
    return process.env.AI_WEBSITE_MOCK === 'true';
  }

  // Opt-in automatic run for freshly deepened leads (LeadsService.deepen) — only when
  // AI_WEBSITE_AUTO=true. Off by default: every call spends real money.
  enqueueAuto(leadId: string): void {
    if (process.env.AI_WEBSITE_AUTO !== 'true') return;
    this.autoQueue.add(leadId);
    if (!this.state.running) void this.drainAutoQueue();
  }

  private async drainAutoQueue(): Promise<void> {
    await sleep(5000); // let a deepening wave add more leads first — one batch, fewer calls
    if (this.state.running || this.autoQueue.size === 0) return;
    const ids = [...this.autoQueue];
    this.autoQueue.clear();
    await this.startBatch(ids);
  }

  async startBatch(
    leadIds: string[],
  ): Promise<{ started: boolean; companies: number; leads: number; skippedIneligible: number; skippedCap: number; mock: boolean; reason?: string; alreadyRunning?: boolean }> {
    const mock = this.isMock;
    if (this.state.running) {
      return { started: false, companies: 0, leads: 0, skippedIneligible: 0, skippedCap: 0, mock, reason: 'An AI website search is already running.', alreadyRunning: true };
    }
    if (!mock && !process.env.OPENAI_API_KEY) {
      return { started: false, companies: 0, leads: 0, skippedIneligible: 0, skippedCap: 0, mock, reason: 'OPENAI_API_KEY is missing in backend/.env.' };
    }

    const rows = await this.db
      .select({
        id: job_leads.id,
        company: job_leads.company,
        job_title: job_leads.job_title,
        location: job_leads.location,
        description: job_leads.description,
        source_url: job_leads.source_url,
        company_website: job_leads.company_website,
        company_website_source: job_leads.company_website_source,
        company_website_note: job_leads.company_website_note,
      })
      .from(job_leads)
      .where(and(isNull(job_leads.deleted_at), inArray(job_leads.id, leadIds)));

    // Eligible: has a company name, no reliable website yet (none, or only a flagged guess), and
    // not an already-paid-for dead end.
    const groups = new Map<string, CompanyGroup>();
    let skippedIneligible = 0;
    for (const r of rows) {
      const unreliable = !r.company_website || r.company_website_source === 'description_guess' || r.company_website_source === 'ai_guess';
      const deadEnd = (r.company_website_note ?? '').startsWith(AI_NOT_FOUND_NOTE_PREFIX);
      if (!r.company?.trim() || !unreliable || deadEnd) {
        skippedIneligible++;
        continue;
      }
      const key = companyKey(r.company);
      let g = groups.get(key);
      if (!g) {
        let countryHost: string | null = null;
        try {
          countryHost = new URL(r.source_url).hostname;
        } catch {
          // leave null
        }
        g = { key, company: r.company.trim(), leadIds: [], jobTitle: r.job_title, location: r.location, countryHost, description: r.description, hintDomain: null };
        groups.set(key, g);
      }
      g.leadIds.push(r.id);
      if (!g.description && r.description) g.description = r.description;
      if (r.company_website_source === 'description_guess' && r.company_website) {
        g.hintDomain = domainFromAnswer(r.company_website);
      }
    }
    skippedIneligible += leadIds.length - rows.length;

    const all = [...groups.values()];
    const targets = all.slice(0, AI_WEBSITE_RUN_CAP);
    const skippedCap = all.slice(AI_WEBSITE_RUN_CAP).reduce((n, g) => n + g.leadIds.length, 0);
    const leads = targets.reduce((n, g) => n + g.leadIds.length, 0);
    if (targets.length === 0) {
      return { started: false, companies: 0, leads: 0, skippedIneligible, skippedCap, mock, reason: 'None of the selected leads need a website (or they were already searched without result).' };
    }

    this.state = {
      ...IDLE_STATUS,
      running: true,
      mock,
      totalCompanies: targets.length,
      leadsTotal: leads,
      skippedIneligible,
      skippedCap,
      startedAt: new Date().toISOString(),
    };
    void this.run(targets, mock);
    return { started: true, companies: targets.length, leads, skippedIneligible, skippedCap, mock };
  }

  private async run(targets: CompanyGroup[], mock: boolean): Promise<void> {
    try {
      for (let i = 0; i < targets.length; i++) {
        const g = targets[i];
        try {
          // Free first: another lead of this company may already have a reliable website.
          if (await this.reuseKnownWebsite(g, mock)) {
            this.state.reused++;
          } else if (mock) {
            this.logger.log(`[AI WEBSITE] MOCK — would search for "${g.company}" (${g.leadIds.length} lead(s)); nothing saved.`);
            this.state.guessed++;
          } else {
            const outcome = await this.searchAndSave(g);
            this.state[outcome]++;
            if (i < targets.length - 1) await sleep(BETWEEN_CALLS_MS);
          }
        } catch (err) {
          if (err instanceof RateLimitError || /quota|insufficient/i.test(err instanceof Error ? err.message : '')) {
            this.state.quotaExhausted = true;
            this.state.lastError = err instanceof Error ? err.message : String(err);
            this.logger.warn(`[AI WEBSITE] OpenAI quota/rate limit — stopping the run: ${this.state.lastError}`);
            break;
          }
          this.state.failed++;
          this.state.lastError = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[AI WEBSITE] "${g.company}" failed: ${this.state.lastError}`);
        }
        this.state.processedCompanies++;
      }
    } finally {
      this.state.running = false;
      this.state.finishedAt = new Date().toISOString();
      if (this.autoQueue.size > 0) void this.drainAutoQueue();
    }
  }

  private async reuseKnownWebsite(g: CompanyGroup, mock: boolean): Promise<boolean> {
    const [known] = await this.db
      .select({ website: job_leads.company_website, source: job_leads.company_website_source, orgId: job_leads.apollo_organization_id })
      .from(job_leads)
      .where(
        and(
          isNull(job_leads.deleted_at),
          isNotNull(job_leads.company_website),
          sql`lower(trim(${job_leads.company})) = ${g.key}`,
          sql`(${job_leads.company_website_source} in ('confirmed', 'ai_verified', 'job_posting'))`,
        ),
      )
      .limit(1);
    if (!known?.website) return false;
    if (!mock) {
      await this.saveForGroup(g, known.website, known.source === 'confirmed' ? 'confirmed' : 'ai_verified', `Same company as another lead with a ${known.source} website — reused, no AI call.`);
    }
    return true;
  }

  private async searchAndSave(g: CompanyGroup): Promise<'verified' | 'guessed' | 'notFound'> {
    const answer = await this.askOpenAi(g);
    const domain = domainFromAnswer(answer.website);
    if (!domain) {
      await this.db
        .update(job_leads)
        .set({ company_website_note: `${AI_NOT_FOUND_NOTE_PREFIX} (${answer.confidence}): ${answer.reasoning}`, updated_at: new Date() })
        .where(inArray(job_leads.id, g.leadIds));
      return 'notFound';
    }
    const check = await verifySite(domain, g.company);
    // A parked domain means the AI's answer is wrong — treated as "not found", never saved.
    if (check.parked) {
      await this.db
        .update(job_leads)
        .set({
          company_website_note: `${AI_NOT_FOUND_NOTE_PREFIX} — AI suggested ${domain}, but that domain does not exist or is parked / for sale. ${answer.reasoning}`,
          updated_at: new Date(),
        })
        .where(inArray(job_leads.id, g.leadIds));
      return 'notFound';
    }
    const reliable = answer.confidence !== 'low' && check.loaded && check.mentionsCompany && !answer.is_recruiting_agency;
    const siteCheck = siteCheckText(check);
    const note =
      `AI (${answer.confidence}${answer.is_recruiting_agency ? ', poster looks like a recruiting agency' : ''}; ${siteCheck}): ` +
      answer.reasoning;
    await this.saveForGroup(g, `https://${domain}`, reliable ? 'ai_verified' : 'ai_guess', note);
    return reliable ? 'verified' : 'guessed';
  }

  // Free re-check of already saved AI websites (no OpenAI call) — e.g. after the site check itself
  // was improved. Upgrades ai_guess -> ai_verified when the site now loads and mentions the company
  // (and the original answer was confident and not an agency); a parked domain is removed and the
  // lead marked "not found".
  async reverifySaved(): Promise<{ checked: number; upgraded: number; removed: number }> {
    const rows = await this.db
      .select({
        id: job_leads.id,
        company: job_leads.company,
        website: job_leads.company_website,
        source: job_leads.company_website_source,
        note: job_leads.company_website_note,
      })
      .from(job_leads)
      .where(and(isNull(job_leads.deleted_at), isNotNull(job_leads.company_website), inArray(job_leads.company_website_source, ['ai_guess', 'ai_verified'])));
    let upgraded = 0;
    let removed = 0;
    for (const r of rows) {
      const domain = r.website ? domainFromAnswer(r.website) : null;
      if (!domain || !r.company) continue;
      const check = await verifySite(domain, r.company);
      const note = r.note ?? '';
      if (check.parked) {
        await this.db
          .update(job_leads)
          .set({
            company_website: null,
            company_website_source: null,
            company_website_note: `${AI_NOT_FOUND_NOTE_PREFIX} — AI suggested ${domain}, but that domain does not exist or is parked / for sale.`,
            updated_at: new Date(),
          })
          .where(sql`${job_leads.id} = ${r.id}`);
        removed++;
        continue;
      }
      const confident = /^AI \((high|medium)/.test(note) && !note.includes('recruiting agency');
      if (r.source === 'ai_guess' && confident && check.loaded && check.mentionsCompany) {
        await this.db
          .update(job_leads)
          .set({
            company_website_source: 'ai_verified',
            company_website_note: note.replace(/; [^)]*\):/, `; ${siteCheckText(check)}):`),
            updated_at: new Date(),
          })
          .where(sql`${job_leads.id} = ${r.id}`);
        upgraded++;
      }
    }
    return { checked: rows.length, upgraded, removed };
  }

  // Only overwrites leads that still have no reliable website (re-checked at write time).
  private async saveForGroup(g: CompanyGroup, website: string, source: 'ai_verified' | 'ai_guess' | 'confirmed', note: string): Promise<void> {
    await this.db
      .update(job_leads)
      .set({ company_website: website, company_website_source: source, company_website_note: note, updated_at: new Date() })
      .where(
        and(
          inArray(job_leads.id, g.leadIds),
          sql`(${job_leads.company_website} is null or ${job_leads.company_website_source} in ('description_guess', 'ai_guess'))`,
        ),
      );
  }

  private async askOpenAi(g: CompanyGroup): Promise<AiAnswer> {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = [
      'Find the official website of the company that posted this job, using live web search.',
      '',
      `Company name (as shown on the job board): ${g.company}`,
      `Job title: ${g.jobTitle ?? 'unknown'}`,
      `Job location: ${g.location ?? 'unknown'}`,
      `Job board country site: ${g.countryHost ?? 'unknown'}`,
      g.hintDomain ? `A domain mentioned in the job description (may or may not be the company's): ${g.hintDomain}` : '',
      '',
      `Job description excerpt: ${plainExcerpt(g.description) || '(none)'}`,
      '',
      "Return the company's OWN main website (its homepage domain) — never a job board, ATS, LinkedIn, " +
        'Indeed, Glassdoor or social profile. Several companies can share a name: use the location, ' +
        'country and description to pick the right one.',
      'If the poster is a recruiting or staffing agency hiring for an unnamed client, return the ' +
        "agency's website and set is_recruiting_agency to true.",
      'Only report a website your search actually found for this company. If you cannot identify it ' +
        'with reasonable certainty, return an empty website and confidence "low". Never guess a domain ' +
        'from the company name alone.',
    ]
      .filter((line) => line !== '')
      .join('\n');

    const response = await client.responses.create({
      model: MODEL,
      input: prompt,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      tools: [{ type: 'web_search' }],
      text: { format: { type: 'json_schema', name: 'company_website', strict: true, schema: ANSWER_SCHEMA } },
    });

    const usage = response.usage;
    const searches = (response.output ?? []).filter((item) => item.type === 'web_search_call').length;
    this.logger.log(
      `[AI WEBSITE] cost "${g.company}": ${usage?.input_tokens ?? '?'} in / ${usage?.output_tokens ?? '?'} out tokens, ${searches} web search call(s)`,
    );

    const parsed = JSON.parse(response.output_text || '{}') as Partial<AiAnswer>;
    return {
      website: typeof parsed.website === 'string' ? parsed.website : '',
      confidence: parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low',
      is_recruiting_agency: parsed.is_recruiting_agency === true,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 500) : '',
    };
  }
}
