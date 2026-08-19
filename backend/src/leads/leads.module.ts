import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DestinationsModule } from '../destinations/destinations.module';
import { ClaudeClassifierService } from './claude-classifier.service';
import { CompanyLinkedinService } from './company-linkedin.service';
import { GeminiClassifierService } from './gemini-classifier.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [DestinationsModule, AuthModule],
  controllers: [LeadsController],
  providers: [LeadsService, GeminiClassifierService, ClaudeClassifierService, CompanyLinkedinService],
})
export class LeadsModule {}
