import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

// Dashboard bulk "DM Search + Industry selected" (task 4 of 4, 08.09 follow-up) — same shape as
// BackfillCompanyLinkedinDto. The service filters this down to only leads that are actually
// eligible (lpr_results IS NULL — never searched before) — see ApolloBulkSearchService.startBatch.
// No cap on the result, unlike BackfillCompanyLinkedinDto's COMPANY_LINKEDIN_RUN_CAP — see that
// service's own doc comment for why a numeric cap wasn't part of what was confirmed for this
// version.
export class BulkApolloSearchDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  leadIds!: string[];
}
