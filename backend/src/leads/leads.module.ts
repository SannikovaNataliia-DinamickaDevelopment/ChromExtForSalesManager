import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DestinationsModule } from '../destinations/destinations.module';
import { ApolloClassifierService } from './apollo-classifier.service';
import { ClaudeClassifierService } from './claude-classifier.service';
import { CompanyLinkedinService } from './company-linkedin.service';
import { GeminiClassifierService } from './gemini-classifier.service';
import { IndustryClassifierService } from './industry-classifier.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { OpenaiClassifierService } from './openai-classifier.service';
import { OpenaiIndustryClassifierService } from './openai-industry-classifier.service';

@Module({
  imports: [DestinationsModule, AuthModule],
  controllers: [LeadsController],
  providers: [
    LeadsService,
    GeminiClassifierService,
    ClaudeClassifierService,
    OpenaiClassifierService,
    CompanyLinkedinService,
    IndustryClassifierService,
    OpenaiIndustryClassifierService,
    ApolloClassifierService,
  ],
})
export class LeadsModule {}
