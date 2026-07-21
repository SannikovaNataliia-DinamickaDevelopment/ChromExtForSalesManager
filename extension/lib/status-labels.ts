import type { LeadStatus } from './types';

// Ukrainian labels live ONLY in the UI; DB/API always use the English enum values (CLAUDE.md data model).
export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'новий',
  in_progress: 'опрацьовується',
  done: 'опрацьований',
};

export const STATUS_OPTIONS: { value: LeadStatus; label: string }[] = (
  Object.keys(STATUS_LABELS) as LeadStatus[]
).map((value) => ({ value, label: STATUS_LABELS[value] }));
