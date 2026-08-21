import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DestinationsModule } from '../destinations/destinations.module';
import { ClaudeClassifierService } from './claude-classifier.service';
import { CompanyLinkedinService } from './company-linkedin.service';
import { GeminiClassifierService } from './gemini-classifier.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { OpenaiClassifierService } from './openai-classifier.service';

@Module({
  imports: [DestinationsModule, AuthModule],
  controllers: [LeadsController],
  providers: [LeadsService, GeminiClassifierService, ClaudeClassifierService, OpenaiClassifierService, CompanyLinkedinService],
})
export class LeadsModule {}
