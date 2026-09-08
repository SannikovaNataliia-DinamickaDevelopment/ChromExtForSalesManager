import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

// Deleted Leads page bulk "Restore selected". Same shape/validation as BulkDeleteLeadsDto
// (kept as its own file rather than reused directly — that DTO's own doc comment ties it
// specifically to the main dashboard's soft-delete action; this is a separate action on a
// separate page). Same semantics as the single-lead PATCH /leads/:id/restore (clears
// deleted_at, no owner check) — just applied to every id in one request instead of one PATCH
// per lead.
export class BulkRestoreLeadsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  leadIds!: string[];
}
