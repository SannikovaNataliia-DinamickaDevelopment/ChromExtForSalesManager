import { IsEmail, IsISO8601, IsObject, IsOptional, IsString, ValidateIf } from 'class-validator';

// Mirrors JobLead from the extension (lib/parser.ts) and the job_leads columns
// that a parser can actually fill in. id/owner_user_id/status/timestamps are
// server-assigned, not part of the input.
export class CreateLeadDto {
  @IsString()
  source_site!: string;

  @IsString()
  source_url!: string;

  @IsString()
  external_job_id!: string;

  @IsOptional() @IsString() job_title?: string;
  @IsOptional() @IsString() company?: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() salary?: string;
  @IsOptional() @IsString() tech_stack?: string;
  @IsOptional() @IsString() apply_url?: string;
  @IsOptional() @IsString() ats?: string;
  @IsOptional() @IsString() contact_name?: string;
  // Parsers leave this as '' rather than omitting it (Techjobs list has no contact fields at all);
  // only enforce email format when something was actually captured.
  @IsOptional() @ValidateIf((dto) => !!dto.contact_email) @IsEmail() contact_email?: string;
  @IsOptional() @IsString() contact_phone?: string;

  @IsOptional() @IsObject() snapshot?: Record<string, unknown>;

  @IsOptional() @IsISO8601() scraped_at?: string;
  // The vacancy's posted date, parsed from the list card; null/omitted when it couldn't be parsed.
  @IsOptional() @IsISO8601() published_at?: string;
}
