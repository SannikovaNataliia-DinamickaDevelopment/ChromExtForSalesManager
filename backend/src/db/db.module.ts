import { Global, Module } from '@nestjs/common';
import { createDb } from './client';

export const DB = Symbol('DB');

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: () => {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
          throw new Error('DATABASE_URL is not set (copy backend/.env.example to backend/.env)');
        }
        return createDb(connectionString);
      },
    },
  ],
  exports: [DB],
})
export class DbModule {}
