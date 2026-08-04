import type { DeepenedFields } from './deepening-strategy';

// Intentionally a near-duplicate of the JSON-LD extraction in parsers/techjobs.ts rather than
// a shared import — CLAUDE.md scope D explicitly calls for leaving the Techjobs/ITjobs parser
// untouched, and this needs a DOM-based (not HTML-string) version anyway since it runs inside
// a content script against a live `document`, not a fetched string (see wellfound-deepen.ts
// for why: Wellfound's DataDome bot-protection blocks a plain fetch outright, confirmed via a
// direct curl — HTTP 403 with a DataDome challenge page, not the real HTML).
interface JobPostingJsonLd {
  '@type'?: string;
  description?: string;
  datePosted?: string;
  hiringOrganization?: { name?: string; sameAs?: string };
}

function isJobPosting(value: unknown): value is JobPostingJsonLd {
  return !!value && typeof value === 'object' && (value as JobPostingJsonLd)['@type'] === 'JobPosting';
}

// Confirmed against spikes/Wellfound_detail.html: same JobPosting JSON-LD shape as
// Techjobs/ITjobs (description, hiringOrganization.name/sameAs, datePosted), just genuinely
// only reachable once a real browser renders the page.
export function extractWellfoundJobPosting(doc: Document): DeepenedFields | null {
  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));

  for (const script of scripts) {
    let data: unknown;
    try {
      data = JSON.parse(script.textContent ?? '');
    } catch {
      continue;
    }

    const posting = Array.isArray(data) ? data.find(isJobPosting) : isJobPosting(data) ? data : undefined;
    if (!posting) continue;

    const datePosted = posting.datePosted ? new Date(posting.datePosted) : null;
    return {
      description: typeof posting.description === 'string' ? posting.description : '',
      company: posting.hiringOrganization?.name ?? '',
      company_website: posting.hiringOrganization?.sameAs ?? '',
      published_at: datePosted && !Number.isNaN(datePosted.getTime()) ? datePosted.toISOString() : null,
    };
  }

  return null;
}
