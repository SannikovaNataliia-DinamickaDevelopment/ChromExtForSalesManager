import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { getKyivTodayUtcRange } from '../common/format-kyiv-time';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { job_leads, users } from '../db/schema';
import { DESTINATION, Destination } from '../destinations/destination.interface';
import { BulkDeleteLeadsDto } from './dto/bulk-delete-leads.dto';
import { CreateLeadDto } from './dto/create-lead.dto';
import { DeepenLeadDto } from './dto/deepen-lead.dto';
import { GeminiClassifierService } from './gemini-classifier.service';
import type { LeadIsIt } from './lead-is-it';
import { LEAD_RETENTION_DAYS } from './lead-retention';
import { LeadStatus } from './lead-status';
import { isObviouslyNonIt } from './non-it-keywords';

export type LeadSaveResult = {
  lead: typeof job_leads.$inferSelect;
  deduplicated: boolean;
  destination: 'ok' | 'failed';
};

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DESTINATION) private readonly destination: Destination,
    private readonly geminiClassifier: GeminiClassifierService,
  ) {}

  // Shared team lead base (decision log): every authenticated user sees every lead, not
  // just their own. owner_user_id ("created_by") is joined in for display, never filtered on.
  // Soft-deleted leads (deleted_at set) are excluded unconditionally — see findDeleted() for
  // the one place they're still visible.
  async findAll(filters: { status?: string; site?: string }) {
    const conditions = [isNull(job_leads.deleted_at)];
    if (filters.status) {
      conditions.push(eq(job_leads.status, filters.status as LeadStatus));
    }
    if (filters.site) {
      conditions.push(eq(job_leads.source_site, filters.site));
    }

    return this.db
      .select({
        ...getTableColumns(job_leads),
        owner_email: users.email,
        owner_display_name: users.display_name,
      })
      .from(job_leads)
      .leftJoin(users, eq(job_leads.owner_user_id, users.id))
      .where(and(...conditions));
  }

  // Dashboard's /dashboard/deleted page: the one listing that shows soft-deleted leads, most
  // recently deleted first.
  async findDeleted() {
    return this.db
      .select({
        ...getTableColumns(job_leads),
        owner_email: users.email,
        owner_display_name: users.display_name,
      })
      .from(job_leads)
      .leftJoin(users, eq(job_leads.owner_user_id, users.id))
      .where(isNotNull(job_leads.deleted_at))
      .orderBy(desc(job_leads.deleted_at));
  }

  // Dashboard stats strip: global counts, always over ALL non-deleted leads regardless of
  // whatever filters/search are applied to the table below (CLAUDE.md-style decision:
  // "here's everything we have", not "here's what's currently filtered"). Four small
  // aggregate queries rather than fetching every row to count client-side — see the
  // find-deleted service method above for how leads.length would otherwise be shaped; that
  // approach doesn't scale the way COUNT/GROUP BY does as the table grows.
  async getStats() {
    const notDeleted = isNull(job_leads.deleted_at);
    const countExpr = sql<number>`count(*)::int`;

    const [[totalRow], [newTodayRow], bySourceRows, byIsItRows] = await Promise.all([
      this.db.select({ count: countExpr }).from(job_leads).where(notDeleted),
      (() => {
        const { start, end } = getKyivTodayUtcRange();
        return this.db
          .select({ count: countExpr })
          .from(job_leads)
          .where(and(notDeleted, gte(job_leads.scraped_at, start), lt(job_leads.scraped_at, end)));
      })(),
      this.db
        .select({ source_site: job_leads.source_site, count: countExpr })
        .from(job_leads)
        .where(notDeleted)
        .groupBy(job_leads.source_site),
      this.db
        .select({ is_it: job_leads.is_it, count: countExpr })
        .from(job_leads)
        .where(notDeleted)
        .groupBy(job_leads.is_it),
    ]);

    const bySource: Record<string, number> = {};
    for (const row of bySourceRows) bySource[row.source_site] = row.count;

    // Zero-fill every known is_it value so the UI never has to guess whether a missing key
    // means "zero" or "not loaded yet".
    const byIsIt: Record<LeadIsIt, number> = { it: 0, not_it: 0, unprocessed: 0 };
    for (const row of byIsItRows) byIsIt[row.is_it as LeadIsIt] = row.count;

    return {
      total: totalRow?.count ?? 0,
      newToday: newTodayRow?.count ?? 0,
      bySource,
      byIsIt,
    };
  }

  /** POST /leads: DB write always happens; the destination push is separate and never loses the record (CLAUDE.md API). */
  async createOrUpdateMany(creatorUserId: string, items: CreateLeadDto[]): Promise<LeadSaveResult[]> {
    const results: LeadSaveResult[] = [];
    for (const item of items) {
      results.push(await this.createOrUpdateOne(creatorUserId, item));
    }
    return results;
  }

  private async createOrUpdateOne(creatorUserId: string, item: CreateLeadDto): Promise<LeadSaveResult> {
    // Global dedup (decision log): matches across all users, not just the current one.
    const existing = await this.db
      .select()
      .from(job_leads)
      .where(
        or(
          and(eq(job_leads.source_site, item.source_site), eq(job_leads.external_job_id, item.external_job_id)),
          eq(job_leads.source_url, item.source_url),
        ),
      )
      .limit(1);

    const scraped_at = item.scraped_at ? new Date(item.scraped_at) : undefined;
    // Undefined (not null) when the parser found no "Posted" date this time: on insert that's
    // just NULL same as before, but on a dedup UPDATE, undefined is dropped from the SQL SET
    // entirely (drizzle's mapUpdateSet skips undefined), so a value from an earlier parse or
    // deepen backfill is never clobbered by a re-parse that came up empty.
    const published_at = item.published_at ? new Date(item.published_at) : undefined;
    let lead: typeof job_leads.$inferSelect;
    let deduplicated: boolean;

    if (existing[0]) {
      // owner_user_id is intentionally untouched here: it stays the original creator, not
      // whoever re-parsed the posting (shared team lead base decision log).
      deduplicated = true;
      const [updated] = await this.db
        .update(job_leads)
        .set({ ...item, scraped_at, published_at, updated_at: new Date() })
        .where(eq(job_leads.id, existing[0].id))
        .returning();
      lead = updated;
    } else {
      deduplicated = false;
      const [inserted] = await this.db
        .insert(job_leads)
        .values({ ...item, scraped_at, published_at, owner_user_id: creatorUserId })
        .returning();
      lead = inserted;
    }

    const [owner] = await this.db
      .select({ email: users.email, display_name: users.display_name })
      .from(users)
      .where(eq(users.id, lead.owner_user_id))
      .limit(1);

    let destinationStatus: 'ok' | 'failed';
    try {
      const saveResult = await this.destination.save({
        ...lead,
        owner_email: owner?.email ?? null,
        owner_display_name: owner?.display_name ?? null,
      });
      destinationStatus = saveResult.status === 'failed' ? 'failed' : 'ok';
    } catch {
      destinationStatus = 'failed';
    }

    return { lead, deduplicated, destination: destinationStatus };
  }

  // CLAUDE.md scope B: applies fields discovered on a lead's detail page. published_at is
  // backfill-only — never clobbers a date the list card already gave us (last-write-wins
  // still holds, but only for fields the caller actually sent new information for).
  async deepen(id: string, patch: DeepenLeadDto) {
    const [existing] = await this.db.select().from(job_leads).where(eq(job_leads.id, id)).limit(1);
    if (!existing) {
      throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: `Lead ${id} not found` });
    }

    const update: Partial<typeof job_leads.$inferInsert> = { updated_at: new Date() };
    if (patch.description !== undefined) update.description = patch.description;
    if (patch.company !== undefined) update.company = patch.company;
    if (patch.company_website !== undefined) update.company_website = patch.company_website;
    // Truthy check (not just !== undefined): IsOptional() skips IsISO8601() validation for
    // `null` too, so patch.published_at could reach here as null — new Date(null) would
    // silently produce the Unix epoch, a wrong date that's worse than leaving it empty.
    if (patch.published_at && !existing.published_at) {
      update.published_at = new Date(patch.published_at);
    }

    const [updated] = await this.db.update(job_leads).set(update).where(eq(job_leads.id, id)).returning();

    const [owner] = await this.db
      .select({ email: users.email, display_name: users.display_name })
      .from(users)
      .where(eq(users.id, updated.owner_user_id))
      .limit(1);

    let destinationStatus: 'ok' | 'failed';
    try {
      const saveResult = await this.destination.save({
        ...updated,
        owner_email: owner?.email ?? null,
        owner_display_name: owner?.display_name ?? null,
      });
      destinationStatus = saveResult.status === 'failed' ? 'failed' : 'ok';
    } catch {
      destinationStatus = 'failed';
    }

    return { lead: updated, destination: destinationStatus };
  }

  // CLAUDE.md scope C: broad IT/not-IT flag via Gemini. Idempotent/safe to re-run — a lead
  // that's already classified (or still has no description) is a no-op, so calling this
  // repeatedly (e.g. a re-parse retrying leads a previous run left unprocessed) never
  // redoes work or burns quota on leads that don't need it.
  async classify(id: string): Promise<{ lead: typeof job_leads.$inferSelect; outcome: LeadIsIt; quotaExhausted: boolean }> {
    const [existing] = await this.db.select().from(job_leads).where(eq(job_leads.id, id)).limit(1);
    if (!existing) {
      throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: `Lead ${id} not found` });
    }
    if (existing.is_it !== 'unprocessed' || !existing.description) {
      return { lead: existing, outcome: existing.is_it, quotaExhausted: false };
    }

    // Cheap pre-filter (no API call, no quota spent): obviously non-IT titles never need to
    // ask Gemini at all. Conservative by design — see non-it-keywords.ts.
    if (isObviouslyNonIt(existing.job_title ?? '')) {
      const updated = await this.applyIsIt(existing, 'not_it');
      return { lead: updated, outcome: 'not_it', quotaExhausted: false };
    }

    const { outcome, quotaExhausted } = await this.geminiClassifier.classify(existing.job_title ?? '', existing.description);
    if (outcome === 'unprocessed') {
      // NFR-12/13: quota/parse failure leaves the lead as-is (already 'unprocessed') so a
      // later re-run can retry it — never crash, never guess.
      return { lead: existing, outcome, quotaExhausted };
    }

    const updated = await this.applyIsIt(existing, outcome);
    return { lead: updated, outcome, quotaExhausted: false };
  }

  private async applyIsIt(existing: typeof job_leads.$inferSelect, is_it: LeadIsIt) {
    const [updated] = await this.db
      .update(job_leads)
      .set({ is_it, updated_at: new Date() })
      .where(eq(job_leads.id, existing.id))
      .returning();

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
      // Sheet push failure shouldn't fail the classify call — the DB write already succeeded.
    }

    return updated;
  }

  // Status is shared per lead (decision log), so any authenticated user may update any lead.
  async updateStatus(id: string, status: LeadStatus) {
    const [updated] = await this.db
      .update(job_leads)
      .set({ status, updated_at: new Date() })
      .where(eq(job_leads.id, id))
      .returning();
    if (!updated) {
      throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: `Lead ${id} not found` });
    }
    return updated;
  }

  // Soft delete (any authenticated user, no owner check — same shared-lead-base rule as
  // status). Idempotent: deleting an already-deleted lead just refreshes deleted_at.
  async softDelete(id: string) {
    const [updated] = await this.db
      .update(job_leads)
      .set({ deleted_at: new Date(), updated_at: new Date() })
      .where(eq(job_leads.id, id))
      .returning();
    if (!updated) {
      throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: `Lead ${id} not found` });
    }
    return updated;
  }

  // Dashboard "Delete selected" — same semantics as softDelete above (sets deleted_at, no
  // owner check), applied to every id in one statement instead of one PATCH per lead. A plain
  // DB write, so unlike bulk enrich this never needs extension involvement — the dashboard
  // calls this endpoint directly. Missing/already-deleted ids are silently not-matched rather
  // than erroring (mirrors an UPDATE...WHERE IN's natural behavior; the caller only cares how
  // many actually changed).
  async bulkSoftDelete({ leadIds }: BulkDeleteLeadsDto): Promise<{ deleted: number }> {
    if (leadIds.length === 0) return { deleted: 0 };
    const updated = await this.db
      .update(job_leads)
      .set({ deleted_at: new Date(), updated_at: new Date() })
      .where(inArray(job_leads.id, leadIds))
      .returning({ id: job_leads.id });
    return { deleted: updated.length };
  }

  // /dashboard/deleted's "Restore" action.
  async restore(id: string) {
    const [updated] = await this.db
      .update(job_leads)
      .set({ deleted_at: null, updated_at: new Date() })
      .where(eq(job_leads.id, id))
      .returning();
    if (!updated) {
      throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: `Lead ${id} not found` });
    }
    return updated;
  }

  // Hard delete — irreversible. Used both for /dashboard/deleted's "Delete permanently" action
  // (on an already soft-deleted lead) and the documented DELETE /leads/:id API in general; it
  // doesn't require deleted_at to be set first, matching plain REST-delete semantics.
  async remove(id: string) {
    const [deleted] = await this.db.delete(job_leads).where(eq(job_leads.id, id)).returning();
    if (!deleted) {
      throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: `Lead ${id} not found` });
    }
    return deleted;
  }

  // Retention purge (CLAUDE.md-style decision log: soft delete first, hard-purge after
  // LEAD_RETENTION_DAYS). Deliberately a single stateless query comparing the stored
  // deleted_at against NOW() at call-time — no in-memory timer/countdown, so a backend
  // restart can never reset, extend, or otherwise affect how much of the window has elapsed;
  // whatever's actually expired gets purged the next time this runs, on whatever schedule.
  async purgeExpiredDeleted(): Promise<number> {
    const cutoff = new Date(Date.now() - LEAD_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const purged = await this.db
      .delete(job_leads)
      .where(and(isNotNull(job_leads.deleted_at), lt(job_leads.deleted_at, cutoff)))
      .returning({ id: job_leads.id });
    if (purged.length > 0) {
      this.logger.log(`Purged ${purged.length} soft-deleted lead(s) past the ${LEAD_RETENTION_DAYS}-day retention window.`);
    }
    return purged.length;
  }

  // Scheduled trigger for the purge above. Daily is plenty for a low-volume local tool — the
  // correctness of WHO gets purged never depends on how often this fires (see
  // purgeExpiredDeleted's comment), only on wall-clock time versus the stored deleted_at, so a
  // missed or delayed tick just means expired leads get caught on the next one, nothing lost.
  // POST /leads/deleted/purge-now (LeadsController) runs the exact same method on demand, for
  // verifying this works without waiting on the schedule or the retention window.
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleScheduledPurge(): Promise<void> {
    await this.purgeExpiredDeleted();
  }
}
