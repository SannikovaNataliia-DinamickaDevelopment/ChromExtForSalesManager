import type { JobLead, SiteParser } from '../types';

const BASE_URL = 'https://devitjobs.nl';

// A real posting anchor is exactly "/jobs/<slug>" (one segment, not "all").
// This excludes two other href shapes that live inside/around the same cards:
//   - "/jobs/<Category>/all"  — technology-badge links to a category page
//   - "/jobs/all/<City>"      — location-filter links in the page header
// Sponsored/external cards (Indeed-injected listings) have no "/jobs/..." href
// at all, so they're excluded automatically by this same check.
function postingSlugFromHref(href: string | null): string | undefined {
  const match = href?.match(/^\/jobs\/([^/]+)$/);
  return match && match[1] !== 'all' ? match[1] : undefined;
}

function slugFromUrl(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    return url.split('/').filter(Boolean).pop() ?? '';
  }
}

// Card title attribute reads "<Job title> job in <City>" (optionally with
// "bij <Company>" folded into the title portion too — see companyFromCard).
function locationFromTitleAttr(titleAttr: string): string {
  const match = titleAttr.match(/job in (.+)$/i);
  return match ? match[1].trim() : '';
}

function titleCaseSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// Company is not a separate labelled field on the card. Prefer "bij <Company>"
// when the poster included it in the job title; otherwise fall back to the
// logo filename, which DevITjobs derives from the company name
// ("cloud-republic-logo-<id>.jpg" -> "Cloud Republic"). Sponsored cards use a
// generic "placeholder-logo.png" which doesn't match and yields no company.
function companyFromCard(jobTitle: string, logoSrc: string | undefined): string {
  const bijMatch = jobTitle.match(/\bbij\s+(.+)$/i);
  if (bijMatch) return bijMatch[1].trim();

  const filename = logoSrc ? (logoSrc.split('/').pop() ?? '') : '';
  const logoMatch = filename.match(/^(.+)-logo-\d+\.\w+$/i);
  return logoMatch ? titleCaseSlug(logoMatch[1]) : '';
}

/**
 * DevITjobs list parser (CLAUDE.md "Parser spec" — RICH).
 *
 * The list is a virtualized window (react-window): at any scroll position the
 * DOM only contains the currently-rendered rows (`li.list-style-type-none` /
 * `[data-test="card"]`), not the full result set — consistent with FR-5 (no
 * auto-scroll/paging), this parses whatever is currently rendered.
 *
 * The JSON-LD `ItemList` is a same-page SSR snapshot that can name postings
 * not currently rendered as cards; it's used here only to supplement the DOM
 * result (source_url/external_job_id only, no card fields available) — never
 * to cap it, since the DOM commonly has more rows loaded than the JSON-LD list.
 *
 * description/apply_url/ats/contact_* stay empty — detail-page only.
 */
export class DevitjobsListParser implements SiteParser {
  parseList(document: Document): JobLead[] {
    const scraped_at = new Date().toISOString();
    const leads: JobLead[] = [];
    const seenSlugs = new Set<string>();

    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-test="card"]'));
    for (const card of cards) {
      const anchors = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href^="/jobs/"]'));
      const anchor = anchors.find((a) => postingSlugFromHref(a.getAttribute('href')));
      const external_job_id = anchor ? postingSlugFromHref(anchor.getAttribute('href')) : undefined;
      if (!anchor || !external_job_id || seenSlugs.has(external_job_id)) continue;
      seenSlugs.add(external_job_id);

      const titleAttr = anchor.getAttribute('title') ?? '';
      const job_title = card.querySelector('.font-weight-bold')?.textContent?.trim()
        || titleAttr.replace(/\s*job in .+$/i, '').trim();
      const location = locationFromTitleAttr(titleAttr);
      const salary = card.querySelector('[aria-label="jaarlijkse salarisbereik"]')?.textContent?.trim() ?? '';
      const tech_stack = Array.from(card.querySelectorAll('[data-test="badge"]'))
        .map((el) => el.textContent?.trim())
        .filter((text): text is string => !!text)
        .join(', ');
      const logoSrc = card.querySelector<HTMLImageElement>('img')?.getAttribute('src') ?? undefined;
      const company = companyFromCard(job_title, logoSrc);

      leads.push({
        source_site: 'devitjobs',
        source_url: `${BASE_URL}/jobs/${external_job_id}`,
        external_job_id,
        job_title,
        location,
        company,
        salary,
        description: '',
        tech_stack,
        apply_url: '',
        ats: '',
        contact_name: '',
        contact_email: '',
        contact_phone: '',
        scraped_at,
        snapshot: {},
      });
    }

    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      let data: unknown;
      try {
        data = JSON.parse(script.textContent ?? '');
      } catch {
        continue;
      }
      for (const candidate of Array.isArray(data) ? data : [data]) {
        const itemList = candidate as { '@type'?: string; itemListElement?: { url?: string }[] };
        if (itemList?.['@type'] !== 'ItemList' || !Array.isArray(itemList.itemListElement)) continue;
        for (const item of itemList.itemListElement) {
          if (!item?.url) continue;
          const external_job_id = slugFromUrl(item.url);
          if (!external_job_id || seenSlugs.has(external_job_id)) continue;
          seenSlugs.add(external_job_id);
          leads.push({
            source_site: 'devitjobs',
            source_url: item.url,
            external_job_id,
            job_title: '',
            location: '',
            company: '',
            salary: '',
            description: '',
            tech_stack: '',
            apply_url: '',
            ats: '',
            contact_name: '',
            contact_email: '',
            contact_phone: '',
            scraped_at,
            snapshot: {},
          });
        }
      }
    }

    return leads;
  }
}
