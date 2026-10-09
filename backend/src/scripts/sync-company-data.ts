import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { CompanyDataSyncService } from '../leads/company-data-sync.service';

// One-off / maintenance: share company data between all leads of each company (no paid calls) —
// see CompanyDataSyncService.
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const result = await app.get(CompanyDataSyncService).syncCompanies();
    console.log(`Checked ${result.companies} companies; ${result.updatedLeads} lead(s) filled from other leads of the same company.`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
