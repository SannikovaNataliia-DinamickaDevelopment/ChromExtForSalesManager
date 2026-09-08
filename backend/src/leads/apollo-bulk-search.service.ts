import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, inArray, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { job_leads } from '../db/schema';
import { LeadsService } from './leads.service';

// No existing Apollo-specific sequential-pacing constant anywhere in this codebase — Apollo has
// only ever been called for one lead at a time before this task (the sidebar's single-lead DM
// Search button), never in a loop. Reusing Company-LinkedIn discovery's own DELAY_MS
// (company-linkedin.service.ts) rather than inventing a new value, per this task's own
// instruction to reuse an existing convention if one exists. Worth flagging as a follow-up
// decision: that value was chosen for a plain public-webpage fetch with no rate-limit/credit
// concern — a different situation from Apollo's metered, credit-consuming API — so 300ms is a
// borrowed placeholder, not a value confirmed against Apollo's own rate limits.
const DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ApolloBulkSearchStatus {
  running: boolean;
  processed: number;
  total: number;
  found: number; // result.ok && people.length > 0
  noResults: number; // result.ok && people.length === 0 — Apollo ran, found nobody
  failed: number; // result.ok === false, or the call itself threw
  // Selected leads that were already searched (lpr_results not null) or weren't found in the DB
  // (e.g. deleted between selection and submit) — skipped up front, never attempted, never
  // re-touched. No skippedCap counterpart — this feature has no run cap (see startBatch's own
  // comment).
  skippedIneligible: number;
  startedAt: string | null;
  finishedAt: string | null;
}

const IDLE_STATUS: ApolloBulkSearchStatus = {
  running: false,
  processed: 0,
  total: 0,
  found: 0,
  noResults: 0,
  failed: 0,
  skippedIneligible: 0,
  startedAt: null,
  finishedAt: null,
};

/**
 * Bulk "DM Search + Industry selected" (task 4 of 4, 08.09 follow-up, per the 27.08/01.09 client
 * calls). Apollo-only — always calls LeadsService.lprSearch(id, 'apollo'), never
 * OpenAI/Gemini/Claude. The sidebar's single-lead "DM Search" button is untouched: it keeps its
 * own existing provider default and can still re-run a search on an already-searched lead; this
 * bulk button can't (see startBatch's eligibility rule below).
 *
 * One Apollo call per lead does double duty: it populates lpr_results (DM/LPR contacts) AND,
 * inside ApolloClassifierService.searchLeadership, resolves/caches the lead's Apollo
 * organization — which is what populates apollo_industry as a side effect (see
 * apollo-classifier.service.ts's resolveOrganization/persistOrganization). So this one bulk
 * action covers both the DM search and the industry backfill with no separate call.
 *
 * Architecturally the same shape as CompanyLinkedinService (company-linkedin.service.ts) —
 * purely backend-driven (LeadsService.lprSearch never touches the extension/a browser tab, same
 * as Company-LinkedIn's own plain fetch), row-selection-scoped, an in-process async batch NEVER
 * awaited by its HTTP caller, single-flight via this module-scoped `state`, polled through
 * getStatus() for live progress. Deliberately NO run cap (unlike COMPANY_LINKEDIN_RUN_CAP) —
 * out of scope for this version, not discussed with the client; the dashboard's own confirmation
 * popup (stating the exact selected-and-eligible count before the batch starts) is the intended
 * safeguard instead, since each lead here spends real Apollo credits.
 */
@Injectable()
export class ApolloBulkSearchService {
  private readonly logger = new Logger(ApolloBulkSearchService.name);
  private state: ApolloBulkSearchStatus = { ...IDLE_STATUS };

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly leadsService: LeadsService,
  ) {}

  getStatus(): ApolloBulkSearchStatus {
    return { ...this.state };
  }

  async startBatch(
    leadIds: string[],
  ): Promise<{ started: boolean; total: number; skippedIneligible: number; reason?: string; alreadyRunning?: boolean }> {
    if (this.state.running) {
      return {
        started: false,
        total: 0,
        skippedIneligible: 0,
        reason: 'An Apollo bulk search is already running.',
        alreadyRunning: true,
      };
    }

    const rows = await this.db
      .select({ id: job_leads.id, lpr_results: job_leads.lpr_results })
      .from(job_leads)
      .where(and(isNull(job_leads.deleted_at), inArray(job_leads.id, leadIds)));
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Eligible strictly means: never searched before (lpr_results IS NULL) — per this task's own
    // spec. The sidebar's single-lead button stays the only way to re-run a search on a lead
    // that already has lpr_results. Preserves the order leadIds arrived in (the dashboard's own
    // selection order), same convention as CompanyLinkedinService.startBackfill.
    const targets: string[] = [];
    let skippedIneligible = 0;
    for (const id of leadIds) {
      const row = byId.get(id);
      if (row && row.lpr_results === null) {
        targets.push(id);
      } else {
        skippedIneligible++;
      }
    }

    if (targets.length === 0) {
      return {
        started: false,
        total: 0,
        skippedIneligible,
        reason: 'None of the selected leads need an Apollo search.',
      };
    }

    this.state = {
      ...IDLE_STATUS,
      running: true,
      total: targets.length,
      skippedIneligible,
      startedAt: new Date().toISOString(),
    };

    void this.run(targets);

    return { started: true, total: targets.length, skippedIneligible };
  }

  private async run(targets: string[]): Promise<void> {
    try {
      for (let i = 0; i < targets.length; i++) {
        const id = targets[i];
        try {
          const result = await this.leadsService.lprSearch(id, 'apollo');
          if (result.ok) {
            if (result.people && result.people.length > 0) this.state.found++;
            else this.state.noResults++;
          } else {
            this.state.failed++;
          }
        } catch (err) {
          // lprSearch throws (LEAD_NOT_FOUND/MISSING_COMPANY) rather than returning ok:false for
          // these two cases — same "one bad item must not abort the run" principle as
          // CompanyLinkedinService.run's own try/catch.
          this.logger.warn(
            `Apollo bulk search: unexpected error for lead ${id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.state.failed++;
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
}
