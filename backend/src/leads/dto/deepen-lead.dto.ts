import { IsISO8601, IsOptional, IsString } from 'class-validator';

// Fields only ever discovered by visiting a lead's detail page (CLAUDE.md scope B):
// the list page never has these. published_at here is a backfill candidate only —
// LeadsService.deepen() applies it solely when the lead doesn't already have one.
export class DeepenLeadDto {
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() company?: string;
  @IsOptional() @IsString() company_website?: string;
  @IsOptional() @IsISO8601() published_at?: string;
  // A definitive, non-retriable deepening failure for this lead (e.g. a Wellfound posting
  // that 404s — removed/expired, not a bot-block or a timeout). Presence of this field alone
  // (no content fields) is how LeadsService.deepen() tells "record an error" apart from a
  // normal successful save — see that method for the full contract.
  @IsOptional() @IsString() enrichment_error?: string;
}
