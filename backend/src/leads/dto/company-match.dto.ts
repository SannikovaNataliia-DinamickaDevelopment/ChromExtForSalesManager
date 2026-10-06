import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

// Dashboard "Find company in Apollo" → the candidate the manager picked (see
// LeadsService.applyCompanyMatch). website is required: the downstream DM search needs a domain.
export class CompanyMatchDto {
  @IsString()
  @IsNotEmpty()
  organizationId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  website!: string;

  // Also apply to every other lead with the same company name that has no website yet or only a
  // description guess (one Apollo search covers e.g. all 9 EPAM leads).
  @IsOptional()
  @IsBoolean()
  applyToSameCompany?: boolean;
}
