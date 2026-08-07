// Soft-deleted leads (job_leads.deleted_at set) are hard-purged this many days after deletion
// — see LeadsService.purgeExpiredDeleted() and its scheduled trigger. Change this single
// constant to adjust the retention window; nothing else needs updating.
export const LEAD_RETENTION_DAYS = 30;
