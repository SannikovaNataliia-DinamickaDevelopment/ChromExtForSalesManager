import type { Db } from './client';
import { users } from './schema';

/**
 * Phase 1-4 stand-in for real auth: `job_leads.owner_user_id` is a FK, so the
 * DEV_USER_ID from .env must exist in `users` before any lead can be written.
 */
export async function ensureDevUser(db: Db, devUserId: string) {
  await db
    .insert(users)
    .values({ id: devUserId, email: 'dev@local.test', display_name: 'Dev User' })
    .onConflictDoNothing({ target: users.id });
}
