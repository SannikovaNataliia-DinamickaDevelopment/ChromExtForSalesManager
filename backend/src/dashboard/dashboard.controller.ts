import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { renderDashboardPage } from './dashboard-page';
import { renderDeletedLeadsPage } from './deleted-leads-page';

// Separate, additive module (see module docstring): this cookie name is duplicated (not
// imported) from auth/auth.controller.ts on purpose, so this whole folder can be deleted along
// with the small forDashboard branch there without either side leaving a dangling import.
const DASHBOARD_SESSION_COOKIE = 'sm_dashboard_session';

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

@Controller()
export class DashboardController {
  constructor(private readonly authService: AuthService) {}

  // Shared by both dashboard pages below: same session cookie, same "no/invalid token ->
  // bounce to Google login" behavior. Returns whether the caller already handled the response
  // (redirected) so callers just `if (this.requireSession(req, res)) return;`.
  private requireSession(req: Request, res: Response): boolean {
    const token = readCookie(req.headers.cookie, DASHBOARD_SESSION_COOKIE);
    if (!token) {
      res.redirect('/auth/login?for=dashboard');
      return true;
    }
    try {
      this.authService.verifySessionToken(token);
    } catch {
      res.redirect('/auth/login?for=dashboard');
      return true;
    }
    return false;
  }

  // Read-only leads browser (see CLAUDE.md / this feature's own request): reuses the existing
  // GET /leads API and the same Google login as the extension, entirely client-side rendered.
  @Get('dashboard')
  dashboard(@Req() req: Request, @Query('auth_error') authError: string | undefined, @Res() res: Response) {
    if (this.requireSession(req, res)) return;
    res.status(200).type('html').send(renderDashboardPage({ authError }));
  }

  // Soft-deleted leads (retention-window feature): its own page, own route, same auth gate.
  @Get('dashboard/deleted')
  deletedLeads(@Req() req: Request, @Res() res: Response) {
    if (this.requireSession(req, res)) return;
    res.status(200).type('html').send(renderDeletedLeadsPage());
  }
}
