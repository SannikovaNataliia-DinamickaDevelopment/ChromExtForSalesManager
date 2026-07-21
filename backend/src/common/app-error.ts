import { HttpException, HttpStatus } from '@nestjs/common';

/** Throw this anywhere a caller needs a stable machine-readable `code`, per the CLAUDE.md error shape. */
export class AppError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string) {
    super({ code, message }, status);
  }
}
