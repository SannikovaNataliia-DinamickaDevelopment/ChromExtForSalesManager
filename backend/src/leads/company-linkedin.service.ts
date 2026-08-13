import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { job_leads, users } from '../db/schema';
import { DESTINATION, Destination } from '../destinations/destination.interface';

// One clear number: the hard cap on how many leads a single run ever attempts. No separate
// circuit breaker on top of this (an earlier version had one — removed: each request here
// targets a different external domain, so consecutive failures are a weak "we're blocked"
// signal, not worth a second tunable alongside this cap).
export const COMPANY_LINKEDIN_RUN_CAP = 50;
const FETCH_TIMEOUT_MS = 8000;
const DELAY_MS = 300;
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
  // Selected leads that were already resolved ('found'/'not_specified') or had no
  // company_website — skipped up front, never attempted, never re-touched.
  skippedIneligible: number;
  // Eligible leads beyond the COMPANY_LINKEDIN_RUN_CAP cut — untried this run, re-selectable
  // (still 'not_checked') on a later run.
  skippedCap: number;
  startedAt: string | null;
  finishedAt: string | null;
}

const IDLE_STATUS: CompanyLinkedinStatus = {
  running: false,
  processed: 0,
  total: 0,
  found: 0,
  notSpecified: 0,
  skippedIneligible: 0,
  skippedCap: 0,
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
 * Row-selection-scoped, same interaction pattern as the dashboard's other bulk actions (Enrich
 * selected / Backfill contact selected / Delete selected) — startBackfill() takes the leadIds
 * the dashboard's checkboxes selected, not a server-picked batch. Still deliberately server-side
 * and single-flight (module-scoped `state` below): the async loop is NEVER awaited by its HTTP
 * caller and keeps running in this Node process regardless of whether the dashboard tab that
 * triggered it stays open (see this feature's CLAUDE.md section for why — no CORS-safe way for
 * the dashboard's own JS to read an arbitrary external site's response body, so the real fetch
 * has to be server-side either way). getStatus() is polled by the dashboard for live progress.
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

  async startBackfill(
    leadIds: string[],
  ): Promise<{ started: boolean; total: number; skippedIneligible: number; skippedCap: number; reason?: string; alreadyRunning?: boolean }> {
    if (this.state.running) {
      return {
        started: false,
        total: 0,
        skippedIneligible: 0,
        skippedCap: 0,
        reason: 'A company-LinkedIn backfill is already running.',
        alreadyRunning: true,
      };
    }

    const rows = await this.db
      .select({ id: job_leads.id, company_website: job_leads.company_website, company_linkedin_status: job_leads.company_linkedin_status })
      .from(job_leads)
      .where(and(isNull(job_leads.deleted_at), inArray(job_leads.id, leadIds)));
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Eligible strictly means: still not_checked AND has a company_website — never re-touches a
    // lead already resolved to 'found'/'not_specified', and skips leads with nothing to fetch.
    // Preserves the order leadIds arrived in (the dashboard's own selection order), not DB order.
    const eligible: { id: string; company_website: string }[] = [];
    let skippedIneligible = 0;
    for (const id of leadIds) {
      const row = byId.get(id);
      if (row && row.company_website && row.company_linkedin_status === 'not_checked') {
        eligible.push({ id: row.id, company_website: row.company_website });
      } else {
        skippedIneligible++;
      }
    }

    const targets = eligible.slice(0, COMPANY_LINKEDIN_RUN_CAP);
    const skippedCap = eligible.length - targets.length;

    if (targets.length === 0) {
      return {
        started: false,
        total: 0,
        skippedIneligible,
        skippedCap,
        reason: 'None of the selected leads need a company-LinkedIn check.',
      };
    }

    this.state = {
      ...IDLE_STATUS,
      running: true,
      total: targets.length,
      skippedIneligible,
      skippedCap,
      startedAt: new Date().toISOString(),
    };

    void this.run(targets);

    return { started: true, total: targets.length, skippedIneligible, skippedCap };
  }

  private async run(targets: { id: string; company_website: string }[]): Promise<void> {
    try {
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        try {
          const urls = await this.extractLinkedinUrls(target.company_website);
          await this.save(target.id, urls);
          if (urls.length > 0) this.state.found++;
          else this.state.notSpecified++;
        } catch (err) {
          // extractLinkedinUrls() never throws (a fetch failure resolves to []) — reaching here
          // means the DB write/Sheets push itself failed unexpectedly. Logged, not retried
          // within this run; the lead stays 'not_checked' for a later run to pick up.
          this.logger.warn(
            `Company-LinkedIn backfill: unexpected error for lead ${target.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        this.state.processed++;

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
