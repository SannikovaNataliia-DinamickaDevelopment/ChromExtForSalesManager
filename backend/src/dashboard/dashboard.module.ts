import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DashboardController } from './dashboard.controller';

// Additive, self-contained (see feature request): read-only leads browser at GET /dashboard.
// Only touches the rest of the app via AuthModule (to verify the same session token) and its
// registration in app.module.ts — delete this folder + that one import + the small
// forDashboard branch in auth.controller.ts/auth.service.ts to remove the feature entirely.
@Module({
  imports: [AuthModule],
  controllers: [DashboardController],
})
export class DashboardModule {}
