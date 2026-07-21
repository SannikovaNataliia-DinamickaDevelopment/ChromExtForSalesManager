export const LEAD_STATUSES = ['new', 'in_progress', 'done'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
