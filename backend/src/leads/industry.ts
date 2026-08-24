// Industry classification (24.08 follow-up, per the 19.08 call) — kept as its own small
// constant file, same "DB enum in schema.ts + a separate plain-TS list here" convention already
// used by lead-status.ts/lead-is-it.ts (schema.ts doesn't import from leads/, so the two lists
// are independently written, not DRY'd together — intentional layering, not an oversight).
// Fixed 20-value taxonomy confirmed with the manager before implementation; expected to gain
// values over time as real "Other" entries reveal gaps (see industryEnum's own comment in
// schema.ts) — adding a value here requires the matching DB migration to ADD it to the Postgres
// enum type too.
export const INDUSTRY_VALUES = [
  'Real Estate',
  'Healthcare',
  'Banking & Financial Services',
  'Insurance',
  'Energy',
  'Retail & E-commerce',
  'Education',
  'Manufacturing',
  'Transportation & Logistics',
  'Hospitality & Travel',
  'Legal Services',
  'Media & Entertainment',
  'Telecommunications',
  'Government & Public Sector',
  'Non-profit',
  'Agriculture',
  'Construction',
  'Software Development',
  'Professional Services & Consulting',
  'Other',
] as const;

export type Industry = (typeof INDUSTRY_VALUES)[number];
