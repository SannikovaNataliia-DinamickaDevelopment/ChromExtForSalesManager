import { IsISO8601, IsOptional, IsString } from 'class-validator';

// Fields only ever discovered by visiting a lead's detail page (CLAUDE.md scope B):
// the list page never has these. published_at here is a backfill candidate only —
// LeadsService.deepen() applies it solely when the lead doesn't already have one.
export class DeepenLeadDto {
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() company?: string;
  @IsOptional() @IsString() company_website?: string;
  @IsOptional() @IsISO8601() published_at?: string;
}
