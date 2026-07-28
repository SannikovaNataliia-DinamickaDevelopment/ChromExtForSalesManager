import { Body, Controller, Delete, Get, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionPayload } from '../auth/types';
import { AppError } from '../common/app-error';
import { CreateLeadDto } from './dto/create-lead.dto';
import { DeepenLeadDto } from './dto/deepen-lead.dto';
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

  // CLAUDE.md scope C: called once per deepened-but-unclassified lead by the extension's
  // rate-limit-paced classify loop. No body — reads title/description from the DB itself and
  // calls Gemini (NFR-3: the backend is allowed to talk to Gemini directly, unlike job sites).
  @Patch(':id/classify')
  async classify(@Param('id') id: string) {
    return this.leadsService.classify(id);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.leadsService.remove(id);
  }
}
