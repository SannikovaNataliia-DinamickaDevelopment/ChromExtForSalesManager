import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

// Dashboard bulk "AI website selected" — AiWebsiteService.startBatch filters the selection down
// to leads that still need a website and groups them by company (one OpenAI call per company).
export class AiWebsiteDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  leadIds!: string[];
}
