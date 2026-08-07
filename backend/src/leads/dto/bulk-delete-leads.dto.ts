import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

// Dashboard bulk "Delete selected". Same semantics as the single-lead PATCH /leads/:id/delete
// (sets deleted_at, no owner check) — just applied to every id in one request instead of one
// PATCH per lead.
export class BulkDeleteLeadsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  leadIds!: string[];
}
