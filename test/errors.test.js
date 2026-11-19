import test from 'node:test';
import assert from 'node:assert/strict';
import { httpError } from '../src/errors.js';

const now = Date.parse('2026-11-19T09:00:00Z');
test('429 reports Retry-After seconds or HTTP date without capping a long wait', () => {
  assert.match(httpError(429, '7200', now).message, /2026-11-19T11:00:00.000Z/);
  assert.match(httpError(429, 'Thu, 19 Nov 2026 12:00:00 GMT', now).message, /2026-11-19T12:00:00.000Z/);
  assert.equal(httpError(429, '7200', now).retryAt, now + 7200000);
});
test('missing, malformed, expired and overflowing Retry-After use exponential backoff', () => {
  for (const header of ['', '-1', 'private-header', 'Wed, 18 Nov 2026 12:00:00 GMT', '9'.repeat(400)]) {
    const error = httpError(429, header, now);
    assert.equal(error.code, 'rate_limited');
    assert.match(error.message, /exponential backoff/);
    assert.equal(error.retryAt, undefined);
    assert.doesNotMatch(error.message, /private-header/);
  }
});
test('access and authentication errors are distinct from transient server failures', () => {
  assert.equal(httpError(403).code, 'access_denied');
  assert.equal(httpError(401).code, 'session_expired');
  assert.equal(httpError(503).code, 'http_error');
  assert.equal(httpError(404).code, 'unexpected_response');
  assert.equal(httpError(200), null);
});
