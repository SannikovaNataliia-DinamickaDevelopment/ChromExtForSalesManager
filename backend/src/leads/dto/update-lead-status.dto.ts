import { IsIn } from 'class-validator';
import { LEAD_STATUSES, LeadStatus } from '../lead-status';

// NFR-8: status is validated server-side, never trusted as a free string.
export class UpdateLeadStatusDto {
  @IsIn(LEAD_STATUSES)
  status!: LeadStatus;
}
