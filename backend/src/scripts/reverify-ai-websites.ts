import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AiWebsiteService } from '../leads/ai-website.service';

// Free re-check of saved AI websites (no OpenAI call) — see AiWebsiteService.reverifySaved.
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await app.get(AiWebsiteService).reverifySaved();
    console.log(`Re-checked ${result.checked} AI website(s): ${result.upgraded} upgraded to verified, ${result.removed} removed (parked domain).`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
