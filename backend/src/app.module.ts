import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DbModule } from './db/db.module';
import { LeadsModule } from './leads/leads.module';

// ScheduleModule.forRoot() enables @Cron()/@Interval() decorators app-wide (must be registered
// exactly once, at the root). Added for LeadsService's deleted-lead retention purge — see
// lead-retention.ts — the first thing in this backend that needs recurring background work.
@Module({
  imports: [DbModule, AuthModule, LeadsModule, DashboardModule, ScheduleModule.forRoot()],
})
export class AppModule {}
