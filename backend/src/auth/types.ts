import type { Request } from 'express';

// Also the payload we sign into the backend's own session JWT (CLAUDE.md Auth:
// "the extension only ever holds the backend token").
export interface SessionPayload {
  sub: string; // internal users.id
  email: string;
  name?: string;
  jti: string;
}

export interface AuthenticatedRequest extends Request {
  user: SessionPayload;
}
