import { IsIn, IsOptional, IsString } from 'class-validator';

// CLAUDE.md Wellfound hiring-contact tracking: 'found' carries name/role/location, 'not_specified'
// carries none (the deepening visit looked and the section genuinely wasn't on the page). There's
// no 'not_checked' value here on purpose — that's the column's default, never something a caller
// sets explicitly; a lead only reaches this endpoint once it's actually been checked.
export class SetHiringContactDto {
  @IsIn(['found', 'not_specified']) status!: 'found' | 'not_specified';
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsString() location?: string;
}
