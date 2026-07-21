import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SheetsDestination } from '../destinations/sheets.destination';
import { LeadsService } from '../leads/leads.service';

// One-off recovery tool: clears the "Leads" tab and rewrites it fresh from Postgres, in the
// exact column order SheetsDestination uses for normal saves. Run after any change to the
// Sheet's column layout, so rows written under an older layout can't stay misaligned.
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const leadsService = app.get(LeadsService);
    const sheetsDestination = app.get(SheetsDestination);

    const leads = await leadsService.findAll({});
    console.log(`Resyncing ${leads.length} leads to the Sheet...`);
    await sheetsDestination.resyncAll(leads);
    console.log('Done.');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
