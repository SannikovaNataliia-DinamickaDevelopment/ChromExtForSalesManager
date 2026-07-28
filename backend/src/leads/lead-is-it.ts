export const LEAD_IS_IT_VALUES = ['it', 'not_it', 'unprocessed'] as const;
export type LeadIsIt = (typeof LEAD_IS_IT_VALUES)[number];
