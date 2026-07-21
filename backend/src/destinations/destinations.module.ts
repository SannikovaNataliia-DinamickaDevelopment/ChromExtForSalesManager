import { Module } from '@nestjs/common';
import { DESTINATION } from './destination.interface';
import { SheetsDestination } from './sheets.destination';

@Module({
  // SheetsDestination is also exported under its own class token (not just DESTINATION)
  // so maintenance scripts (e.g. resync-sheet) can reach Sheets-specific methods that
  // aren't part of the generic Destination interface, without breaking the abstraction
  // the core (LeadsService) uses.
  providers: [SheetsDestination, { provide: DESTINATION, useExisting: SheetsDestination }],
  exports: [DESTINATION, SheetsDestination],
})
export class DestinationsModule {}
