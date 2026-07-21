import { Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { renderCallbackPage } from './callback-page';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import type { SessionPayload } from './types';

// Routes are top-level (not nested under /auth) for /me per CLAUDE.md API spec:
// "GET /auth/login · GET /auth/callback · GET /me · POST /auth/logout".
@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('auth/login')
  async login(@Query('ext_id') extId: string | undefined, @Res() res: Response) {
    const url = await this.authService.buildAuthorizationUrl(extId);
    res.redirect(url);
  }

  @Get('auth/callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const result = await this.authService.handleCallback(req.query, req);
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
