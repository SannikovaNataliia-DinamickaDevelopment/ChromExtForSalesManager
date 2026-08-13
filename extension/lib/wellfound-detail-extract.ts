import type { DeepenedFields, HiringContact } from './deepening-strategy';

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

// "Hiring contact" section — confirmed live against two real postings (one with a contact
// listed, one without): NOT part of the JSON-LD JobPosting block above, a separately hydrated
// DOM section that either renders or doesn't. Rather than depend on Tailwind utility classes
// (no data-testid on this block, and classes are exactly the kind of thing a redesign changes —
// see CLAUDE.md's Parser spec history for what happened to Techjobs' old selectors), this
// anchors on the literal "Hiring contact" header text the site itself shows the user, which is
// far more stable than any class name.
//
// Confirmed structure (both live samples): the header text node's grandparent contains a
// name/role/location block as three "leaf" elements (no element children of their own, only an
// avatar <img> alongside them, which has no text and is filtered out) in document order:
// name first, then role, then location. Confirmed location can be legitimately absent even
// when name+role are present (one live sample had a role but no location element at all, not
// an empty one) — positional extraction handles that naturally since there's simply no 3rd
// leaf to read.
function extractHiringContact(doc: Document): HiringContact | null {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let headerTextNode: Text | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.trim() === 'Hiring contact') {
      headerTextNode = node as Text;
      break;
    }
  }
  if (!headerTextNode?.parentElement) return null;

  const headerEl = headerTextNode.parentElement;
  const container = headerEl.parentElement;
  if (!container) return null;

  const leaves = Array.from(container.querySelectorAll('*')).filter((el) => {
    if (el === headerEl) return false;
    if (!el.textContent?.trim()) return false;
    return el.children.length === 0;
  });

  const name = leaves[0]?.textContent?.trim() ?? '';
  if (!name) return null;
  const role = leaves[1]?.textContent?.trim() ?? '';
  const location = leaves[2]?.textContent?.trim() ?? '';
  return { name, role, location };
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
      // Read alongside the JobPosting JSON-LD, not before it: finding the JobPosting is our
      // signal the page is actually hydrated, so it's safe to also trust the DOM for the
      // "Hiring contact" section at this same moment (see extractHiringContact's own comment).
      hiring_contact: extractHiringContact(doc),
    };
  }

  return null;
}
