import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, getTableColumns, or } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { job_leads, users } from '../db/schema';
import { DESTINATION, Destination } from '../destinations/destination.interface';
import { CreateLeadDto } from './dto/create-lead.dto';
import { DeepenLeadDto } from './dto/deepen-lead.dto';
import { GeminiClassifierService } from './gemini-classifier.service';
import type { LeadIsIt } from './lead-is-it';
import { LeadStatus } from './lead-status';
import { isObviouslyNonIt } from './non-it-keywords';

export type LeadSaveResult = {
  lead: typeof job_leads.$inferSelect;
  deduplicated: boolean;
  destination: 'ok' | 'failed';
};

@Injectable()
export class LeadsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DESTINATION) private readonly destination: Destination,
    private readonly geminiClassifier: GeminiClassifierService,
  ) {}

  // Shared team lead base (decision log): every authenticated user sees every lead, not
  // just their own. owner_user_id ("created_by") is joined in for display, never filtered on.
  async findAll(filters: { status?: string; site?: string }) {
    const conditions = [];
    if (filters.status) {
      conditions.push(eq(job_leads.status, filters.status as LeadStatus));
    }
    if (filters.site) {
      conditions.push(eq(job_leads.source_site, filters.site));
    }

    const query = this.db
      .select({
        ...getTableColumns(job_leads),
        owner_email: users.email,
        owner_display_name: users.display_name,
      })
      .from(job_leads)
      .leftJoin(users, eq(job_leads.owner_user_id, users.id));

    return conditions.length ? query.where(and(...conditions)) : query;
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

  async remove(id: string) {
    const [deleted] = await this.db.delete(job_leads).where(eq(job_leads.id, id)).returning();
    if (!deleted) {
      throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: `Lead ${id} not found` });
    }
    return deleted;
  }
}
