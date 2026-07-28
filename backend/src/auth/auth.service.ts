import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { Issuer, generators, type Client } from 'openid-client';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { external_identities, users } from '../db/schema';
import { AppError } from '../common/app-error';
import { HttpStatus } from '@nestjs/common';
import type { SessionPayload } from './types';

const SESSION_TTL = '7d';
const STATE_TTL_SECONDS = 5 * 60;

type CallbackResult =
  | { ok: true; token: string; extId: string | null; email: string; forDashboard: boolean }
  | { ok: false; error: string; extId: string | null; forDashboard: boolean };

// Signed, self-contained "state" — carries the extension id + OIDC nonce across
// the redirect to Google and back, with no server-side session store (Deployment: LOCAL, stateless backend).
interface StatePayload {
  extId: string | null;
  nonce: string;
  // Dashboard feature (backend/src/dashboard/): set when /auth/login was reached via
  // /dashboard's redirect, so the callback knows to set a browser cookie instead of relaying
  // the token to the extension. Same Google login, same session token either way.
  forDashboard?: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private client: Client | null = null;
  // Process-lifetime revocation list for POST /auth/logout; resets on backend restart (acceptable for the v1 local prototype).
  private readonly revokedJtis = new Set<string>();

  constructor(@Inject(DB) private readonly db: Db) {}

  private get jwtSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set');
    return secret;
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI must be set');
    }
    const issuer = await Issuer.discover('https://accounts.google.com');
    this.client = new issuer.Client({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: [redirectUri],
      response_types: ['code'],
    });
    return this.client;
  }

  async buildAuthorizationUrl(extId: string | undefined, forDashboard = false): Promise<string> {
    const client = await this.getClient();
    const nonce = generators.nonce();
    const state = jwt.sign({ extId: extId ?? null, nonce, forDashboard } satisfies StatePayload, this.jwtSecret, {
      expiresIn: STATE_TTL_SECONDS,
    });
    return client.authorizationUrl({ scope: 'openid email profile', state, nonce });
  }

  async handleCallback(query: Request['query'], req: Request): Promise<CallbackResult> {
    const rawState = typeof query.state === 'string' ? query.state : '';
    let state: StatePayload;
    try {
      state = jwt.verify(rawState, this.jwtSecret) as StatePayload;
    } catch {
      return {
        ok: false,
        error: 'Login link expired or invalid. Please try signing in again.',
        extId: null,
        forDashboard: false,
      };
    }

    const forDashboard = state.forDashboard ?? false;

    if (query.error) {
      return { ok: false, error: String(query.error), extId: state.extId, forDashboard };
    }

    const client = await this.getClient();
    const params = client.callbackParams(req);
    let tokenSet;
    try {
      tokenSet = await client.callback(process.env.GOOGLE_REDIRECT_URI, params, {
        state: rawState,
        nonce: state.nonce,
      });
    } catch (err) {
      this.logger.error('Google token exchange failed', err as Error);
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Google authentication failed',
        extId: state.extId,
        forDashboard,
      };
    }

    const claims = tokenSet.claims();
    if (!claims.email) {
      return { ok: false, error: 'Google account has no email claim', extId: state.extId, forDashboard };
    }

    const userId = await this.resolveUser(claims.sub, claims.email, claims.name);
    const token = this.issueSessionToken(userId, claims.email, claims.name);
    return { ok: true, token, extId: state.extId, email: claims.email, forDashboard };
  }

  private async resolveUser(providerUserId: string, email: string, name?: string): Promise<string> {
    const existing = await this.db
      .select()
      .from(external_identities)
      .where(and(eq(external_identities.provider, 'google'), eq(external_identities.provider_user_id, providerUserId)))
      .limit(1);
    if (existing[0]) return existing[0].user_id;

    const [user] = await this.db
      .insert(users)
      .values({ email, display_name: name ?? email })
      .returning();
    await this.db.insert(external_identities).values({
      user_id: user.id,
      provider: 'google',
      provider_user_id: providerUserId,
      email,
    });
    return user.id;
  }

  private issueSessionToken(userId: string, email: string, name?: string): string {
    const jti = randomUUID();
    return jwt.sign({ sub: userId, email, name, jti } satisfies SessionPayload, this.jwtSecret, {
      expiresIn: SESSION_TTL,
    });
  }

  verifySessionToken(token: string): SessionPayload {
    let payload: SessionPayload;
    try {
      payload = jwt.verify(token, this.jwtSecret) as SessionPayload;
    } catch {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Invalid or expired session. Please sign in again.');
    }
    if (this.revokedJtis.has(payload.jti)) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Session was signed out. Please sign in again.');
    }
    return payload;
  }

  revoke(jti: string) {
    this.revokedJtis.add(jti);
  }
}
