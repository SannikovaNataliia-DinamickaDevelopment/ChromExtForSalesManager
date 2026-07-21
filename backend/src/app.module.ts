import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { DbModule } from './db/db.module';
import { LeadsModule } from './leads/leads.module';

@Module({
  imports: [DbModule, AuthModule, LeadsModule],
})
export class AppModule {}
