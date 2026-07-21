import type { JobLead, SiteParser } from '../types';

const BASE_URL = 'https://www.techjobs.ca';
const INFO_SPAN_SELECTOR = 'span.text-sm.text-gray-700';

/**
 * Techjobs.ca list parser (CLAUDE.md "Parser spec" — SHALLOW).
 * Techjobs is Next.js/RSC: this parses the rendered DOM, never `self.__next_f`.
 * List cards don't carry company/salary/description/tech_stack/apply_url/ats/contact_* —
 * those stay empty here and are only ever filled by a separate manual per-lead "deepen" action.
 */
export class TechjobsListParser implements SiteParser {
  parseList(document: Document): JobLead[] {
    const cards = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/job/"]'));
    const scraped_at = new Date().toISOString();

    return cards.map((card) => {
      const href = card.getAttribute('href') ?? '';
      const external_job_id = href.split('/').filter(Boolean).pop() ?? '';
      const source_url = `${BASE_URL}${href}`;
      const job_title = card.querySelector('h3')?.textContent?.trim() ?? '';

      const infoSpans = Array.from(card.querySelectorAll(INFO_SPAN_SELECTOR));
      const location = infoSpans[0]?.textContent?.trim() ?? '';
      const employment_type = infoSpans[1]?.textContent?.trim();
      const seniority = infoSpans[2]?.textContent?.trim();

      const posted = Array.from(card.querySelectorAll('span'))
        .map((el) => el.textContent?.trim())
        .find((text): text is string => !!text && text.startsWith('Posted '));

      const lead: JobLead = {
        source_site: 'techjobs',
        source_url,
        external_job_id,
        job_title,
        location,
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
        snapshot: { employment_type, seniority, posted },
      };
      return lead;
    });
  }
}
