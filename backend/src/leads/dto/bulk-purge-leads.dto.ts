import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

// Deleted Leads page bulk "Delete permanently selected". Same shape/validation as
// BulkDeleteLeadsDto — kept as its own file for the same reason as BulkRestoreLeadsDto (a
// separate action on a separate page, not the main dashboard's soft-delete). Same semantics as
// the single-lead DELETE /leads/:id (irreversible, doesn't require deleted_at to be set first)
// — just applied to every id in one request instead of one DELETE per lead.
export class BulkPurgeLeadsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  leadIds!: string[];
}
