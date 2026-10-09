import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { job_leads } from '../db/schema';
import { companyKey, leadCountry } from './company-key';
import { registrableDomain } from './company-website-from-description';

// Company data shared across all leads of one company (09.10). A company's data is the same for
// every one of its vacancies, so whatever was found once — by the AI website finder, an Apollo
// company pick, "Confirm website", a DM search — is copied to its other leads, and a newly parsed
// lead of a known company gets it immediately, with no paid call:
//  - company-level (shared across ALL countries): website (+ source/flag + note), Apollo
//    organization id and industry fields, industry, company LinkedIn, the AI "no website found"
//    dead-end note;
//  - decision-makers (DM / lpr_*): only between leads in the SAME COUNTRY — a large company's
//    country/regional leaders differ (live 09.10: CI&T's results mixed Brazilian founders with a
//    "CTO, EMEA").
// Fields are only ever FILLED or UPGRADED (a less reliable website replaced by a more reliable
// one), never cleared. Grouping is in application code over all leads (companyKey) — fine at the
// current table size (hundreds of rows); revisit with a stored key column if it grows large.

type WebsiteSource = typeof job_leads.$inferSelect['company_website_source'];

// How much a website can be trusted, by where it came from. Null source with a website = saved
// before sources existed, which was always structured posting data.
const WEBSITE_RANK: Record<string, number> = {
  confirmed: 5,
  job_posting: 4,
  ai_verified: 3,
  ai_guess: 2,
  description_guess: 1,
};

function websiteRank(website: string | null, source: WebsiteSource): number {
  if (!website) return 0;
  return source ? WEBSITE_RANK[source] ?? 0 : WEBSITE_RANK.job_posting;
}

function domainOf(website: string | null): string | null {
  if (!website) return null;
  try {
    return registrableDomain(new URL(website.includes('://') ? website : `https://${website}`).hostname);
  } catch {
    return null;
  }
}

const AI_NOT_FOUND_PREFIX = 'AI: no website found';

@Injectable()
export class CompanyDataSyncService {
  private readonly logger = new Logger(CompanyDataSyncService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Shares company data between leads of the given companies (by name, any spelling — grouped by
   * companyKey), or of ALL companies when called without names. Returns how many leads changed.
   */
  async syncCompanies(companyNames?: (string | null | undefined)[]): Promise<{ companies: number; updatedLeads: number }> {
    const wanted = companyNames ? new Set(companyNames.map(companyKey).filter(Boolean)) : null;
    if (wanted && wanted.size === 0) return { companies: 0, updatedLeads: 0 };

    const rows = await this.db
      .select()
      .from(job_leads)
      .where(and(isNull(job_leads.deleted_at), isNotNull(job_leads.company)));

    const groups = new Map<string, (typeof rows)[number][]>();
    for (const r of rows) {
      const key = companyKey(r.company);
      if (!key || (wanted && !wanted.has(key))) continue;
      const list = groups.get(key);
      if (list) list.push(r);
      else groups.set(key, [r]);
    }

    let updatedLeads = 0;
    for (const leads of groups.values()) {
      if (leads.length < 2) continue;
      updatedLeads += await this.syncGroup(leads);
    }
    return { companies: groups.size, updatedLeads };
  }

  private async syncGroup(leads: (typeof job_leads.$inferSelect)[]): Promise<number> {
    // Best website in the group.
    const websiteDonor = [...leads].sort(
      (a, b) => websiteRank(b.company_website, b.company_website_source) - websiteRank(a.company_website, a.company_website_source),
    )[0];
    const bestRank = websiteRank(websiteDonor.company_website, websiteDonor.company_website_source);
    const bestDomain = domainOf(websiteDonor.company_website);
    const deadEnd = leads.find((l) => !l.company_website && (l.company_website_note ?? '').startsWith(AI_NOT_FOUND_PREFIX));

    let changed = 0;
    for (const t of leads) {
      const patch: Partial<typeof job_leads.$inferInsert> = {};
      const tCountry = leadCountry(t.source_site, t.source_url);

      // Website: fill or upgrade.
      if (bestRank > websiteRank(t.company_website, t.company_website_source) && websiteDonor.id !== t.id) {
        const dCountry = leadCountry(websiteDonor.source_site, websiteDonor.source_url);
        patch.company_website = websiteDonor.company_website;
        patch.company_website_source = websiteDonor.company_website_source ?? 'job_posting';
        patch.company_website_note =
          `Copied from another lead of this company${dCountry !== tCountry ? ` (${dCountry.toUpperCase()} vacancy)` : ''}` +
          (websiteDonor.company_website_note ? ` — ${websiteDonor.company_website_note}` : '');
      } else if (!t.company_website && !t.company_website_note && deadEnd && deadEnd.id !== t.id) {
        patch.company_website_note = deadEnd.company_website_note;
      }

      // Everything below belongs to the website the target ends up with — only copied from a
      // donor with the same website domain, so data of a different company never leaks in.
      const tDomain = domainOf((patch.company_website as string | undefined) ?? t.company_website);
      const sameSite = (d: typeof t) => !!tDomain && domainOf(d.company_website) === tDomain && d.id !== t.id;

      const orgDonor = leads.find((d) => sameSite(d) && d.apollo_organization_id);
      if (!t.apollo_organization_id && orgDonor) {
        patch.apollo_organization_id = orgDonor.apollo_organization_id;
        patch.apollo_organization_resolved_at = orgDonor.apollo_organization_resolved_at;
        patch.apollo_industry = orgDonor.apollo_industry;
        patch.apollo_industries = orgDonor.apollo_industries;
        patch.apollo_secondary_industries = orgDonor.apollo_secondary_industries;
        patch.apollo_keywords = orgDonor.apollo_keywords;
        patch.apollo_short_description = orgDonor.apollo_short_description;
      }

      const industryDonor = leads.find((d) => sameSite(d) && d.industry);
      if (!t.industry && industryDonor) {
        patch.industry = industryDonor.industry;
        patch.industry_other_description = industryDonor.industry_other_description;
        patch.industry_classified_at = industryDonor.industry_classified_at;
      }

      const linkedinDonor = leads.find((d) => sameSite(d) && d.company_linkedin_status !== 'not_checked');
      if (t.company_linkedin_status === 'not_checked' && linkedinDonor) {
        patch.company_linkedin_status = linkedinDonor.company_linkedin_status;
        patch.company_linkedin_urls = linkedinDonor.company_linkedin_urls;
      }

      // DM: same website AND same country only; the most recent search wins.
      if (!t.lpr_results) {
        const dmDonor = leads
          .filter((d) => sameSite(d) && d.lpr_results && leadCountry(d.source_site, d.source_url) === tCountry)
          .sort((a, b) => (b.lpr_searched_at?.getTime() ?? 0) - (a.lpr_searched_at?.getTime() ?? 0))[0];
        if (dmDonor) {
          patch.lpr_results = dmDonor.lpr_results;
          patch.lpr_reasoning = `Copied from another ${tCountry.toUpperCase()} lead of this company — ${dmDonor.lpr_reasoning ?? ''}`.trim();
          patch.lpr_provider = dmDonor.lpr_provider;
          patch.lpr_searched_at = dmDonor.lpr_searched_at;
        }
      }

      if (Object.keys(patch).length > 0) {
        patch.updated_at = new Date();
        await this.db.update(job_leads).set(patch).where(eq(job_leads.id, t.id));
        changed++;
      }
    }
    if (changed > 0) this.logger.log(`[COMPANY SYNC] "${leads[0].company}": ${changed} lead(s) filled from other leads of the company`);
    return changed;
  }
}
