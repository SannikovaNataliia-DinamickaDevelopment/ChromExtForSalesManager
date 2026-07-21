import type { job_leads } from '../db/schema';

// The raw row plus the creator's identity (shared team lead base decision log:
// owner_user_id = "created_by"), joined in by LeadsService before every destination.save().
export type JobLeadRecord = typeof job_leads.$inferSelect & {
  owner_email: string | null;
  owner_display_name: string | null;
};

export type SaveResult = {
  status: 'created' | 'updated' | 'failed';
  externalRef?: string;
  error?: { code: string; message: string };
};

/**
 * The core (LeadsService) only ever talks to this interface (FR-10/NFR-14):
 * swapping in a HubSpot or other adapter later means writing a new class here,
 * not touching leads.service.ts.
 */
export interface Destination {
  save(record: JobLeadRecord): Promise<SaveResult>;
}

export const DESTINATION = Symbol('DESTINATION');
