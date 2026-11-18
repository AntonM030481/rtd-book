export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function publicError(error) {
  return error instanceof AppError
    ? { code: error.code, message: error.message }
    : { code: 'operation_failed', message: 'The operation failed. Check the RTD window: the page may have changed or failed to load.' };
}
