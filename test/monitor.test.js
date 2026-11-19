import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../src/monitor.js';
import { AppError, httpError } from '../src/errors.js';
import { defaults } from '../src/settings.js';
const settings = { ...defaults, dateFrom: '2026-12-04', dateTo: '2026-12-04' };
const response = (slots = []) => ({ status: 'ok', centre: '1', category: settings.category, dates: ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05'], slots, available: slots.length, unavailable: 0, unknown: 0 });
const slot = { date: '2026-12-04', time: '08:30', availability: 'available' };

test('concurrent checks rejected; stop during a request prevents rescheduling', async () => {
  let finish;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const monitor = new Monitor({ selectDate: async () => {}, check: () => { calls++; started(); return new Promise(resolve => { finish = resolve; }); } }, settings);
  const running = monitor.start();
  await assert.rejects(monitor.check(), { code: 'busy' });
  await ready;
  monitor.stop(); finish(response()); await running;
  assert.equal(calls, 1); assert.equal(monitor.running, false); assert.equal(monitor.nextCheck, null);
});
test('expired session preserves last known result as stale and stops monitor', async () => {
  let fail = false;
  const monitor = new Monitor({ selectDate: async () => {}, check: async () => { if (fail) throw new AppError('session_expired', 'expired'); return response([slot]); } }, settings);
  await monitor.check(); fail = true; await monitor.start();
  assert.equal(monitor.result.matches.length, 1); assert.equal(monitor.lastError.code, 'session_expired');
  assert.equal(monitor.running, false); assert.equal(monitor.nextCheck, null);
});
test('deduplicate alerts, but a disappeared and returned slot is new', async () => {
  let slots = [slot];
  const counts = [];
  const monitor = new Monitor({ selectDate: async () => {}, check: async () => response(slots) }, settings, { onResult: (_, count) => counts.push(count) });
  await monitor.check(); await monitor.check(); slots = []; await monitor.check(); slots = [slot]; await monitor.check();
  assert.deepEqual(counts, [1, 0, 0, 1]); assert.equal(monitor.notificationSeq, 2);
});
test('transport errors back off and stop after three consecutive failures', async () => {
  const monitor = new Monitor({ selectDate: async () => {}, check: async () => { throw new AppError('request_failed', 'network'); } }, settings);
  await monitor.start(); assert.equal(monitor.running, true);
  assert.ok(Date.parse(monitor.nextCheck) - Date.now() > 230000);
  await monitor.check(); assert.ok(Date.parse(monitor.nextCheck) - Date.now() > 470000);
  await monitor.check(); assert.equal(monitor.running, false); assert.equal(monitor.nextCheck, null);
});

for (const status of [403, 401]) {
  test(`HTTP ${status} aborts the scan, preserves stale results and schedules no retry`, async () => {
    let calls = 0;
    const monitor = new Monitor({ selectDate: async () => { calls++; throw httpError(status, '900'); } }, settings);
    const previous = { matches: [slot] };
    monitor.result = previous;
    await monitor.start();
    assert.equal(monitor.result, previous);
    assert.equal(monitor.lastError.code, httpError(status).code);
    assert.equal(monitor.running, false);
    assert.equal(monitor.nextCheck, null);
    assert.equal(calls, 1);
  });
}

test('429 doubles intervals, caps at one hour, and resets after a successful pass', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  let limited = true;
  let calls = 0;
  const monitor = new Monitor({ selectDate: async () => { calls++; if (limited) throw httpError(429); }, check: async () => response() }, settings);
  t.after(() => monitor.stop(false));
  const previous = { matches: [slot] };
  monitor.result = previous;
  await monitor.start();
  for (const seconds of [240, 480, 960, 1920, 3600, 3600]) {
    assert.equal(monitor.running, true);
    assert.equal(monitor.result, previous);
    assert.equal(Date.parse(monitor.nextCheck) - Date.now(), seconds * 1000);
    const count = calls;
    await assert.rejects(monitor.restart(), { code: 'cooldown' });
    await assert.rejects(monitor.check(), { code: 'cooldown' });
    assert.equal(calls, count);
    t.mock.timers.setTime(Date.parse(monitor.nextCheck));
    await monitor.check();
  }
  limited = false;
  t.mock.timers.setTime(Date.parse(monitor.nextCheck));
  await monitor.check();
  assert.equal(monitor.failures, 0);
  assert.equal(monitor.lastError, null);
  assert.equal(Date.parse(monitor.nextCheck) - Date.now(), 120000);
});

test('Retry-After survives range wrapping and takes precedence over shorter backoff', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const monitor = new Monitor({ selectDate: async () => { throw httpError(429, '7200'); } }, settings);
  t.after(() => monitor.stop(false));
  await monitor.start();
  assert.equal(Date.parse(monitor.nextCheck) - Date.now(), 7200000);
  assert.equal(monitor.lastError.retryAt, Date.parse(monitor.nextCheck));
});

test('scheduled 429 retry runs automatically, while stop cancels waiting', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  let calls = 0;
  let completed;
  const result = new Promise(resolve => { completed = resolve; });
  const monitor = new Monitor({ selectDate: async () => { if (++calls === 1) throw httpError(429); }, check: async () => response() }, settings, { onResult: completed });
  t.after(() => monitor.stop(false));
  await monitor.start();
  t.mock.timers.tick(239999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await result;
  assert.equal(calls, 2);
  monitor.stop(false);
  t.mock.timers.tick(1200000);
  assert.equal(calls, 2);
});

test('once reports 429 without starting a retry timer', async () => {
  const monitor = new Monitor({ selectDate: async () => { throw httpError(429); } }, settings);
  await monitor.check();
  assert.equal(monitor.running, false);
  assert.equal(monitor.nextCheck, null);
  assert.equal(monitor.lastError.code, 'rate_limited');
});

test('a long Retry-After does not overflow the timer into an early request', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  let calls = 0;
  const monitor = new Monitor({ selectDate: async () => { calls++; throw httpError(429, '2592000'); } }, settings);
  t.after(() => monitor.stop(false));
  await monitor.start();
  t.mock.timers.tick(2147483647);
  assert.equal(calls, 1);
  assert.equal(monitor.running, true);
  assert.equal(Date.parse(monitor.nextCheck), 1000000 + 2592000000);
});
