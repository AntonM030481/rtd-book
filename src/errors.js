export class AppError extends Error {
  constructor(code, message, { retryAt } = {}) {
    super(message);
    this.code = code;
    if (Number.isFinite(retryAt)) this.retryAt = retryAt;
  }
}

export function publicError(error) {
  return error instanceof AppError
    ? { code: error.code, message: error.message, ...(Number.isFinite(error.retryAt) ? { retryAt: error.retryAt } : {}) }
    : { code: 'operation_failed', message: 'The operation failed. Check the RTD window: the page may have changed or failed to load.' };
}

// Retry-After can be either seconds or an HTTP date. Never print raw headers.
export function httpError(status, retryAfter = '', now = Date.now()) {
  if (status === 429) {
    const value = retryAfter.trim();
    const deadline = /^\d+$/.test(value) ? now + Number(value) * 1000
      : /^[A-Za-z]{3},/.test(value) ? Date.parse(value) : NaN;
    const retryAt = Number.isFinite(deadline) && deadline > now && deadline <= 8640000000000000 ? deadline : undefined;
    const wait = retryAt ? `Do not retry before ${new Date(retryAt).toISOString()} (UTC).`
      : 'No future Retry-After deadline was provided; watch mode uses exponential backoff.';
    return new AppError('rate_limited', `RTD returned HTTP 429 (too many requests). ${wait}`, { retryAt });
  }
  if (status === 403) return new AppError('access_denied', 'RTD returned HTTP 403 (access denied). Automatic requests stopped. Check access manually before restarting; repeated login attempts are disabled.');
  if (status === 401) return new AppError('session_expired', 'RTD returned HTTP 401 (authentication required). Automatic requests stopped. Restore access manually before restarting.');
  if (status >= 500) return new AppError('http_error', `RTD returned HTTP ${status}. Availability was not checked.`);
  if (status < 200 || status >= 300) return new AppError('unexpected_response', `RTD returned HTTP ${status}. Availability was not checked.`);
  return null;
}
