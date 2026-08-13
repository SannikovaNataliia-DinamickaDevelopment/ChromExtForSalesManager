import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

// Dashboard bulk "Backfill LinkedIn selected" — same shape as BulkDeleteLeadsDto. The service
// filters this down to only leads that are actually eligible (company_website set,
// company_linkedin_status still 'not_checked') and caps the result at
// COMPANY_LINKEDIN_RUN_CAP — see CompanyLinkedinService.startBackfill.
export class BackfillCompanyLinkedinDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  leadIds!: string[];
}
