import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { job_leads, users } from '../db/schema';
import { DESTINATION, Destination } from '../destinations/destination.interface';

// Named + easy to raise once validated, same convention as WELLFOUND_RUN_CAP. Deliberately
// server-side (see this feature's CLAUDE.md section): unlike Wellfound, there's no per-site
// anti-ban reason to keep this small — each request targets a different company's own domain,
// not one job board repeatedly — but the backlog is large, so a per-run cap plus a small
// between-request delay keeps any one run bounded and polite rather than firing dozens of
// outbound connections at once.
export const COMPANY_LINKEDIN_RUN_CAP = 50;
const FETCH_TIMEOUT_MS = 8000;
const DELAY_MS = 300;
// Higher than WELLFOUND_CIRCUIT_BREAKER_THRESHOLD (3) on purpose: consecutive failures here are
// each against a DIFFERENT external domain, a much weaker "we're blocked" signal than Wellfound
// repeatedly failing against the one site it's walking. This guards against a systemic problem
// (outbound network down, DNS broken) rather than any single site's own anti-bot behavior — a
// single unreachable company site is expected and handled as 'not_specified', not a failure at
// all (see extractLinkedinUrls).
const CIRCUIT_BREAKER_THRESHOLD = 8;
const HREF_RE = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CompanyLinkedinStatus {
  running: boolean;
  processed: number;
  total: number;
  found: number;
  notSpecified: number;
  // Untried tail left over if the circuit breaker trips before the batch finishes — a skip, not
  // a failure, same distinction the Wellfound flows make.
  skippedCircuitBreakerCount: number;
  startedAt: string | null;
  finishedAt: string | null;
}

const IDLE_STATUS: CompanyLinkedinStatus = {
  running: false,
  processed: 0,
  total: 0,
  found: 0,
  notSpecified: 0,
  skippedCircuitBreakerCount: 0,
  startedAt: null,
  finishedAt: null,
};

/**
 * Company-LinkedIn discovery (CLAUDE.md): given a lead's own company_website, fetch that page
 * (a plain fetch of an arbitrary external site — NOT a job-site detail page, so this is
 * deliberately its own thing, never piggybacked on the existing Wellfound/Techjobs deepening
 * flows) and collect every unique <a href> containing "linkedin.com". No AI/LLM
 * disambiguation this pass — every match is saved as-is.
 *
 * Deliberately server-side and single-flight (module-scoped `state` below, one job at a time):
 * startBackfill() kicks off an async loop that is NEVER awaited by its caller (the HTTP
 * handler returns immediately) and keeps running in this Node process regardless of whether the
 * dashboard tab that triggered it stays open — see this feature's CLAUDE.md section for why
 * that's the right shape here (no CORS-safe way for the dashboard's own JS to read an arbitrary
 * external site's response body, so the real fetch has to be server-side either way; once it's
 * server-side, there's no reason to make the *looping* client-driven too). getStatus() is
 * polled by the dashboard for live progress and survives a page reload since it's this
 * process's own state, not anything client-held.
 */
@Injectable()
export class CompanyLinkedinService {
  private readonly logger = new Logger(CompanyLinkedinService.name);
  private state: CompanyLinkedinStatus = { ...IDLE_STATUS };

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DESTINATION) private readonly destination: Destination,
  ) {}

  getStatus(): CompanyLinkedinStatus {
    return { ...this.state };
  }

  async startBackfill(): Promise<{ started: boolean; total: number; reason?: string; alreadyRunning?: boolean }> {
    if (this.state.running) {
      return { started: false, total: 0, reason: 'A company-LinkedIn backfill is already running.', alreadyRunning: true };
    }

    // Scoped strictly to not_checked leads that actually have a company_website — never
    // re-touches a lead already resolved to 'found'/'not_specified', even if this endpoint is
    // called again immediately (CLAUDE.md requirement).
    const targets = await this.db
      .select({ id: job_leads.id, company_website: job_leads.company_website })
      .from(job_leads)
      .where(
        and(
          isNull(job_leads.deleted_at),
          isNotNull(job_leads.company_website),
          eq(job_leads.company_linkedin_status, 'not_checked'),
        ),
      )
      .limit(COMPANY_LINKEDIN_RUN_CAP);

    if (targets.length === 0) {
      return { started: false, total: 0, reason: 'No leads currently need a company-LinkedIn check.' };
    }

    this.state = {
      ...IDLE_STATUS,
      running: true,
      total: targets.length,
      startedAt: new Date().toISOString(),
    };

    void this.run(targets as { id: string; company_website: string }[]);

    return { started: true, total: targets.length };
  }

  private async run(targets: { id: string; company_website: string }[]): Promise<void> {
    let consecutiveFailures = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        try {
          const urls = await this.extractLinkedinUrls(target.company_website);
          await this.save(target.id, urls);
          if (urls.length > 0) this.state.found++;
          else this.state.notSpecified++;
          consecutiveFailures = 0;
        } catch (err) {
          // extractLinkedinUrls() never throws (a fetch failure resolves to []) — reaching here
          // means the DB write/Sheets push itself failed unexpectedly, a different and more
          // systemic kind of failure, which DOES count toward the circuit breaker.
          consecutiveFailures++;
          this.logger.warn(
            `Company-LinkedIn backfill: unexpected error for lead ${target.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        this.state.processed++;

        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          this.state.skippedCircuitBreakerCount = targets.length - this.state.processed;
          break;
        }

        if (i < targets.length - 1) {
          await sleep(DELAY_MS);
        }
      }
    } finally {
      this.state.running = false;
      this.state.finishedAt = new Date().toISOString();
    }
  }

  // Never throws — per CLAUDE.md requirement 2, a network error, timeout, non-2xx response, or
  // unparseable/malformed company_website URL are all "couldn't confirm a LinkedIn link", saved
  // identically to "fetched fine, found nothing" (not_specified). No distinction between failure
  // reasons here, unlike Wellfound's definitive-404-vs-timeout split — the spec is explicit that
  // this pass doesn't need one.
  private async extractLinkedinUrls(companyWebsite: string): Promise<string[]> {
    let html: string;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(companyWebsite, { signal: controller.signal });
        if (!res.ok) return [];
        html = await res.text();
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return [];
    }

    const seen = new Set<string>();
    const results: string[] = [];
    HREF_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HREF_RE.exec(html))) {
      const href = match[1] ?? match[2] ?? '';
      if (!href.toLowerCase().includes('linkedin.com')) continue;
      if (seen.has(href)) continue; // exact-duplicate dedupe only, per spec — no normalization
      seen.add(href);
      results.push(href);
    }
    return results;
  }

  private async save(id: string, urls: string[]): Promise<void> {
    const [updated] = await this.db
      .update(job_leads)
      .set({
        company_linkedin_status: urls.length > 0 ? 'found' : 'not_specified',
        company_linkedin_urls: urls,
        updated_at: new Date(),
      })
      .where(eq(job_leads.id, id))
      .returning();

    if (!updated) return;

    const [owner] = await this.db
      .select({ email: users.email, display_name: users.display_name })
      .from(users)
      .where(eq(users.id, updated.owner_user_id))
      .limit(1);

    try {
      await this.destination.save({
        ...updated,
        owner_email: owner?.email ?? null,
        owner_display_name: owner?.display_name ?? null,
      });
    } catch {
      // Sheet push failure shouldn't fail the DB write — same pattern as every other mutation
      // in LeadsService.
    }
  }
}
