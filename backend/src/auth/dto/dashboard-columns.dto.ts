import { IsArray, IsIn } from 'class-validator';
import { EXPORT_COLUMN_KEYS } from '../../leads/export-columns';

// PUT /me/dashboard-columns (Task DI-2966 draggable/hideable dashboard columns). Reuses
// EXPORT_COLUMN_KEYS as the canonical known-column-key list rather than maintaining a second
// one here — the dashboard's ALL_COLUMNS (frontend) and this backend list are already meant to
// describe the exact same set of columns (every column is both a table column and an export
// column now), so validating against a second, separately-maintained list would just reintroduce
// the "list drifts because someone updated one and not the other" bug this project already fixed
// once (see export-columns.ts's own history).
export class DashboardColumnsDto {
  @IsArray()
  @IsIn(EXPORT_COLUMN_KEYS, { each: true })
  order!: string[];

  @IsArray()
  @IsIn(EXPORT_COLUMN_KEYS, { each: true })
  hidden!: string[];
}
