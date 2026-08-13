// Deepening-method-agnostic core (parallel to the backend's Destination adapter pattern —
// CLAUDE.md "core stays destination-agnostic"). Different sources need different access
// methods to their detail pages (a plain fetch works for Techjobs/ITjobs; Wellfound's
// DataDome bot-protection blocks that outright and needs a real browser tab instead — see
// wellfound-deepen.ts), but callers only ever need "give me the fields for this lead."
export interface HiringContact {
  name: string;
  role: string;
  location: string;
}

export interface DeepenedFields {
  description: string;
  company: string;
  company_website: string;
  published_at: string | null;
  // Wellfound-only "Hiring contact" section — a three-way, not a boolean, so callers can tell
  // "this source doesn't check for it" apart from "checked, and it's genuinely absent":
  // undefined = not checked by this strategy (FetchDeepening/Techjobs never sets this at all);
  // null = checked (the detail page loaded fine) and the section wasn't on the page;
  // an object = checked and found. Only wellfound-detail-extract.ts ever produces null/an object.
  hiring_contact?: HiringContact | null;
}

export interface DeepeningTarget {
  id: string;
  source_url: string;
}

export interface DeepeningStrategy {
  // Returns null (never throws for expected failure modes) when the detail page couldn't be
  // read this time — the caller's loop decides how to react (skip and continue, count toward
  // a circuit breaker, etc.), matching NFR-12/13 (no crash, no silent total failure).
  deepenOne(target: DeepeningTarget): Promise<DeepenedFields | null>;
}
