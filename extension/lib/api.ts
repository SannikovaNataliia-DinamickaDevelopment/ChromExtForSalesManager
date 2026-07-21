import { getToken } from './auth';
import { BACKEND_URL } from './backend';
import type { JobLeadRecord, LeadStatus } from './types';

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

export async function updateLeadStatus(id: string, status: LeadStatus): Promise<JobLeadRecord> {
  const res = await fetch(`${BACKEND_URL}/leads/${id}`, {
    method: 'PATCH',
    headers: await authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ status }),
  });
  return unwrap<JobLeadRecord>(res);
}
