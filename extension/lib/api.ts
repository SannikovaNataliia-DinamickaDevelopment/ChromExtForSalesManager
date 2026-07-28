import { getToken } from './auth';
import { BACKEND_URL } from './backend';
import type { JobLead, JobLeadRecord, LeadIsIt, LeadStatus } from './types';

export interface DeepenPatch {
  description?: string;
  company?: string;
  company_website?: string;
  published_at?: string;
}

// Mirrors backend LeadsService.LeadSaveResult (POST /leads' per-item response shape).
export interface LeadSaveResult {
  lead: JobLeadRecord;
  deduplicated: boolean;
  destination: 'ok' | 'failed';
}

// Thrown on 401 so callers can distinguish "please sign in again" from other failures.
export class AuthError extends Error {}

async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const token = await getToken();
  if (!token) throw new AuthError('Not signed in.');
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function unwrap<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    throw new AuthError('Session expired. Please sign in again.');
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export async function fetchLeads(): Promise<JobLeadRecord[]> {
  const res = await fetch(`${BACKEND_URL}/leads`, { headers: await authHeaders() });
  return unwrap<JobLeadRecord[]>(res);
}

// CLAUDE.md scope D: shared by the single-page parse (background.ts, unchanged) and the new
// multi-page incremental parse (multipage.ts) — both just POST whatever the content script
// parsed; dedup/upsert behavior is entirely the backend's (untouched here).
export async function saveLeads(leads: JobLead[]): Promise<LeadSaveResult[]> {
  const res = await fetch(`${BACKEND_URL}/leads`, {
    method: 'POST',
    headers: await authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(leads),
  });
  return unwrap<LeadSaveResult[]>(res);
}

export async function updateLeadStatus(id: string, status: LeadStatus): Promise<JobLeadRecord> {
  const res = await fetch(`${BACKEND_URL}/leads/${id}`, {
    method: 'PATCH',
    headers: await authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ status }),
  });
  return unwrap<JobLeadRecord>(res);
}

// CLAUDE.md scope B: the extension fetches+parses the detail page itself; this just persists
// what it found. published_at is a backfill suggestion only — the backend applies it solely
// when the lead doesn't already have one (see LeadsService.deepen).
export async function deepenLead(id: string, patch: DeepenPatch): Promise<{ lead: JobLeadRecord; destination: 'ok' | 'failed' }> {
  const res = await fetch(`${BACKEND_URL}/leads/${id}/deepen`, {
    method: 'PATCH',
    headers: await authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(patch),
  });
  return unwrap(res);
}

// CLAUDE.md scope C: no body — the backend reads title/description itself and calls Gemini.
// `outcome` stays the lead's prior is_it ('unprocessed') when Gemini errors, hits a quota
// limit, or returns something unparseable; it's never thrown as an error from this call.
// `quotaExhausted` tells the caller the free-tier quota looks exhausted right now (HTTP 429 /
// RESOURCE_EXHAUSTED), as opposed to a one-off failure — see classify.ts for how that's used.
export async function classifyLead(id: string): Promise<{ lead: JobLeadRecord; outcome: LeadIsIt; quotaExhausted: boolean }> {
  const res = await fetch(`${BACKEND_URL}/leads/${id}/classify`, {
    method: 'PATCH',
    headers: await authHeaders(),
  });
  return unwrap(res);
}
