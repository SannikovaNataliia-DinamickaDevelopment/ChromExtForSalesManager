import { ArrayNotEmpty, IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { EXPORT_COLUMN_KEYS } from '../export-columns';

// Dashboard "Export" button. leadIds is the currently-filtered set the dashboard already
// computed client-side (getFiltered()) — same pattern as BulkDeleteLeadsDto, and for the same
// reason: filtering stays single-sourced in the client (CLAUDE.md dashboard section: all
// filters/search are client-side), the server just re-fetches those exact leads fresh from the
// DB rather than trusting any lead data the client might send. columns is optional — omitted
// (or left empty) means "advanced export wasn't used", i.e. every column.
export class ExportLeadsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  leadIds!: string[];

  @IsOptional()
  @IsArray()
  @IsIn(EXPORT_COLUMN_KEYS, { each: true })
  columns?: string[];
}
