import { Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { renderCallbackPage } from './callback-page';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import type { SessionPayload } from './types';

// Dashboard feature (backend/src/dashboard/): cookie name for its browser-tab session, kept as
// a literal (not a shared import) so the whole dashboard/ folder — plus this constant, the
// `for` handling in login(), and the forDashboard branch in callback() below — can be deleted
// without leaving a dangling cross-module import. Must match dashboard.controller.ts's copy.
const DASHBOARD_SESSION_COOKIE = 'sm_dashboard_session';
const DASHBOARD_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function renderDashboardLoginError(message: string): string {
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Sign-in failed</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem;">
  <h2>Sign-in failed</h2>
  <p>${escaped}</p>
  <p><a href="/auth/login?for=dashboard">Try again</a></p>
</body>
</html>`;
}

// Routes are top-level (not nested under /auth) for /me per CLAUDE.md API spec:
// "GET /auth/login · GET /auth/callback · GET /me · POST /auth/logout".
@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('auth/login')
  async login(
    @Query('ext_id') extId: string | undefined,
    @Query('for') forParam: string | undefined,
    @Res() res: Response,
  ) {
    // Dashboard feature: /dashboard redirects here with ?for=dashboard when it has no valid
    // session cookie; everything else about the Google OIDC flow is unchanged.
    const url = await this.authService.buildAuthorizationUrl(extId, forParam === 'dashboard');
    res.redirect(url);
  }

  @Get('auth/callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const result = await this.authService.handleCallback(req.query, req);

    if (result.forDashboard) {
      // Dashboard feature: same session token as the extension gets, just handed to the
      // browser as a cookie instead of relayed over chrome.runtime messaging.
      if (!result.ok) {
        res.status(200).type('html').send(renderDashboardLoginError(result.error));
        return;
      }
      res.cookie(DASHBOARD_SESSION_COOKIE, result.token, {
        httpOnly: false, // the dashboard page's own script reads this to call GET /leads
        sameSite: 'lax',
        maxAge: DASHBOARD_SESSION_MAX_AGE_MS,
        path: '/',
      });
      res.redirect('/dashboard');
      return;
    }

    res.status(200).type('html').send(renderCallbackPage(result));
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: SessionPayload) {
    return { id: user.sub, email: user.email, display_name: user.name ?? user.email };
  }

  @Post('auth/logout')
  @UseGuards(AuthGuard)
  logout(@CurrentUser() user: SessionPayload) {
    this.authService.revoke(user.jti);
    return { ok: true };
  }
}
