import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../src/monitor.js';
import { AppError } from '../src/errors.js';
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
