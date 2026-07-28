import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { renderDashboardPage } from './dashboard-page';

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

  // Read-only leads browser (see CLAUDE.md / this feature's own request): reuses the existing
  // GET /leads API and the same Google login as the extension, entirely client-side rendered.
  @Get('dashboard')
  dashboard(@Req() req: Request, @Query('auth_error') authError: string | undefined, @Res() res: Response) {
    const token = readCookie(req.headers.cookie, DASHBOARD_SESSION_COOKIE);
    if (!token) {
      res.redirect('/auth/login?for=dashboard');
      return;
    }

    try {
      this.authService.verifySessionToken(token);
    } catch {
      res.redirect('/auth/login?for=dashboard');
      return;
    }

    res.status(200).type('html').send(renderDashboardPage({ authError }));
  }
}
