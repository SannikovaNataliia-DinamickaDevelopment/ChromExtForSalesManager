import { Body, Controller, Delete, Get, HttpStatus, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionPayload } from '../auth/types';
import { AppError } from '../common/app-error';
import { BulkDeleteLeadsDto } from './dto/bulk-delete-leads.dto';
import { CreateLeadDto } from './dto/create-lead.dto';
import { DeepenLeadDto } from './dto/deepen-lead.dto';
import { ExportLeadsDto } from './dto/export-leads.dto';
import { SetHiringContactDto } from './dto/set-hiring-contact.dto';
import { UpdateLeadStatusDto } from './dto/update-lead-status.dto';
import { LEAD_STATUSES } from './lead-status';
import { LeadsService } from './leads.service';

@Controller('leads')
@UseGuards(AuthGuard)
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  // Shared team lead base (decision log): every authenticated user sees every lead.
  @Get()
  async findAll(@Query('status') status?: string, @Query('site') site?: string) {
    if (status && !LEAD_STATUSES.includes(status as (typeof LEAD_STATUSES)[number])) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'INVALID_STATUS',
        `status must be one of: ${LEAD_STATUSES.join(', ')}`,
      );
    }
    return this.leadsService.findAll({ status, site });
  }

  // /dashboard/deleted: the one listing that includes soft-deleted leads (findAll excludes
  // them). Declared as a literal 'deleted' path, not a dynamic :id — no route-matching
  // ambiguity with the :id-based routes below.
  @Get('deleted')
  async findDeleted() {
    return this.leadsService.findDeleted();
  }

  // Dashboard stats strip: global counts (total, new today, by source, by IT) — always over
  // ALL non-deleted leads, independent of whatever filters/search are applied to the table.
  // Literal 'stats' path, same non-ambiguity reasoning as 'deleted' above.
  @Get('stats')
  async stats() {
    return this.leadsService.getStats();
  }

  // Dashboard "Export" button. POST (not GET) because leadIds can be the entire filtered lead
  // set (hundreds+) — too long/fragile for a query string. Literal 'export' path, same
  // no-ambiguity reasoning as 'deleted'/'stats' above (doesn't collide with @Post() at the bare
  // /leads root — different segment count, not just different literal text).
  @Post('export')
  async export(@Body() body: unknown, @Res() res: Response) {
    const dto = plainToInstance(ExportLeadsDto, body);
    const errors = await validate(dto);
    if (errors.length > 0) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        errors.map((e) => Object.values(e.constraints ?? {}).join(', ')).join('; '),
      );
    }
    const buffer = await this.leadsService.exportXlsx(dto);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="leads-export-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    });
    res.send(Buffer.from(buffer));
  }

  // Accepts a single lead or an array (CLAUDE.md: "POST /leads accepts a single lead OR an array for batch").
  @Post()
  async create(@CurrentUser() user: SessionPayload, @Body() body: unknown) {
    const wasArray = Array.isArray(body);
    const rawItems = wasArray ? (body as unknown[]) : [body];

    const items = await Promise.all(
      rawItems.map(async (raw, index) => {
        const dto = plainToInstance(CreateLeadDto, raw);
        const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: false });
        if (errors.length > 0) {
          throw new AppError(
            HttpStatus.BAD_REQUEST,
            'VALIDATION_ERROR',
            `Invalid lead at index ${index}: ${errors.map((e) => Object.values(e.constraints ?? {}).join(', ')).join('; ')}`,
          );
        }
        return dto;
      }),
    );

    const results = await this.leadsService.createOrUpdateMany(user.sub, items);
    return wasArray ? results : results[0];
  }

  // Dashboard "Delete selected" (bulk soft delete). Declared as a literal 'bulk-delete' path
  // and — importantly — BEFORE @Patch(':id') below: both are one path segment after /leads,
  // so if updateStatus's :id route were registered first it would swallow
  // "PATCH /leads/bulk-delete" as an update-status call with id="bulk-delete" instead of
  // ever reaching this handler. Route registration order is match order here, not specificity.
  @Patch('bulk-delete')
  async bulkSoftDelete(@Body() body: BulkDeleteLeadsDto) {
    const dto = plainToInstance(BulkDeleteLeadsDto, body);
    const errors = await validate(dto);
    if (errors.length > 0) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'leadIds must be a non-empty array of lead id strings',
      );
    }
    return this.leadsService.bulkSoftDelete(dto);
  }

  // Status is shared per lead (decision log): any authenticated user may change it.
  @Patch(':id')
  async updateStatus(@Param('id') id: string, @Body() body: UpdateLeadStatusDto) {
    const dto = plainToInstance(UpdateLeadStatusDto, body);
    const errors = await validate(dto);
    if (errors.length > 0) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        `status must be one of: ${LEAD_STATUSES.join(', ')}`,
      );
    }
    return this.leadsService.updateStatus(id, dto.status);
  }

  // CLAUDE.md scope B: called once per NEW lead by the extension's human-paced deepen loop,
  // after it fetches the lead's detail page itself and extracts the JSON-LD JobPosting.
  @Patch(':id/deepen')
  async deepen(@Param('id') id: string, @Body() body: unknown) {
    const dto = plainToInstance(DeepenLeadDto, body);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: false });
    if (errors.length > 0) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        errors.map((e) => Object.values(e.constraints ?? {}).join(', ')).join('; '),
      );
    }
    return this.leadsService.deepen(id, dto);
  }

  // Wellfound "Hiring contact" tracking — separate from :id/deepen on purpose, see
  // LeadsService.setHiringContact's comment. Called both by the opportunistic save inside a
  // normal Wellfound deepen and by the dedicated backfill run for already-deepened leads.
  @Patch(':id/contact')
  async setHiringContact(@Param('id') id: string, @Body() body: unknown) {
    const dto = plainToInstance(SetHiringContactDto, body);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: false });
    if (errors.length > 0) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        errors.map((e) => Object.values(e.constraints ?? {}).join(', ')).join('; '),
      );
    }
    return this.leadsService.setHiringContact(id, dto);
  }

  // CLAUDE.md scope C: called once per deepened-but-unclassified lead by the extension's
  // rate-limit-paced classify loop. No body — reads title/description from the DB itself and
  // calls Gemini (NFR-3: the backend is allowed to talk to Gemini directly, unlike job sites).
  @Patch(':id/classify')
  async classify(@Param('id') id: string) {
    return this.leadsService.classify(id);
  }

  // Soft delete (dashboard "Delete" action in the detail panel). Any authenticated user, no
  // owner check — same shared-lead-base rule as status.
  @Patch(':id/delete')
  async softDelete(@Param('id') id: string) {
    return this.leadsService.softDelete(id);
  }

  // /dashboard/deleted's "Restore" action.
  @Patch(':id/restore')
  async restore(@Param('id') id: string) {
    return this.leadsService.restore(id);
  }

  // Hard delete, irreversible — /dashboard/deleted's "Delete permanently" action. Also the
  // pre-existing documented DELETE /leads/:id API, unchanged.
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.leadsService.remove(id);
  }

  // Manual trigger for LeadsService's scheduled retention purge — lets you verify the purge
  // logic works without waiting for the daily cron tick or the LEAD_RETENTION_DAYS window
  // (backdate a test lead's deleted_at directly in Postgres, then call this and confirm the
  // row is gone). Runs the exact same code path as the cron, not a separate implementation.
  @Post('deleted/purge-now')
  async purgeNow() {
    const purged = await this.leadsService.purgeExpiredDeleted();
    return { purged };
  }
}
