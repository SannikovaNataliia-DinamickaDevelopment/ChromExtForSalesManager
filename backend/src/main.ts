import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { DB } from './db/db.module';
import { ensureDevUser } from './db/ensure-dev-user';
import type { Db } from './db/client';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const extensionOrigin = process.env.EXTENSION_ORIGIN;
  app.enableCors({
    origin: extensionOrigin ? [extensionOrigin] : false,
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalFilters(new AllExceptionsFilter());

  // Phase 1-4 stub user, kept only so leads saved before Phase 5 auth still satisfy the owner_user_id FK.
  // Real logins (phase 5) create their own users row via Google OIDC; DEV_USER_ID is no longer required to boot.
  const devUserId = process.env.DEV_USER_ID;
  if (devUserId) {
    await ensureDevUser(app.get<Db>(DB), devUserId);
  }

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Backend listening on http://localhost:${port}`);
}

bootstrap();
