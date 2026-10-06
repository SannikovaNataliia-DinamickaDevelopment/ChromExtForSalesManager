import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { LeadsService } from '../leads/leads.service';

// One-off: guess company_website from the job description for leads saved before that guess
// existed (LeadsService.backfillWebsiteFromDescription). New leads get it automatically when
// deepened. Results are stored flagged ('description_guess') — never sent to Apollo unconfirmed.
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const { checked, found } = await app.get(LeadsService).backfillWebsiteFromDescription();
    console.log(`Checked ${checked} lead(s) with a description and no website; website guessed for ${found}.`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
