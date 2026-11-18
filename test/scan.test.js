import test from 'node:test';
import assert from 'node:assert/strict';
import { planWeeks, scanRange } from '../src/scan.js';
import { Monitor } from '../src/monitor.js';
import { defaults } from '../src/settings.js';
import { AppError } from '../src/errors.js';

const settings = { ...defaults, dateFrom: '2026-12-04', dateTo: '2026-12-11' };
function fakeCalendar(target) {
  const saturday = Date.parse(target);
  const dates = Array.from({ length: 6 }, (_, index) => new Date(saturday - (5 - index) * 86400000).toISOString().slice(0, 10));
  return { centre: settings.centre, category: settings.category, status: 'ok', dates,
    slots: dates.map(date => ({ date, time: '08:30', availability: 'available' })), available: 6, unavailable: 0, unknown: 0 };
}

test('plan every week exactly once across month/year boundaries; skip Sunday-only periods', () => {
  const december = planWeeks('2026-12-01', '2026-12-31');
  assert.equal(december.length, 5);
  assert.deepEqual(december[0], { from: '2026-11-30', to: '2026-12-05', target: '2026-12-05' });
  assert.equal(december.at(-1).target, '2027-01-02');
  assert.equal(planWeeks('2026-12-06', '2026-12-07')[0].from, '2026-12-07');
  assert.throws(() => planWeeks('2026-12-06', '2026-12-06'), { code: 'invalid_settings' });
});

test('serial scan checks each week, removes dates outside bounds and reports full coverage', async () => {
  let target;
  const operations = [];
  const browser = { selectDate: async date => { target = date; operations.push(`select:${date}`); }, check: async () => { operations.push(`check:${target}`); return fakeCalendar(target); } };
  const result = await scanRange(browser, settings, { delay: async () => operations.push('delay') });
  assert.deepEqual(operations, ['select:2026-12-05', 'check:2026-12-05', 'delay', 'select:2026-12-12', 'check:2026-12-12']);
  assert.equal(result.weeksChecked, 2); assert.equal(result.slots.length, 7);
  assert.ok(result.slots.every(slot => slot.date >= settings.dateFrom && slot.date <= settings.dateTo));
  assert.equal(result.available, 7);
});

test('a repeated stale week is not treated as complete range', async () => {
  const browser = { selectDate: async () => {}, check: async () => fakeCalendar('2026-12-05') };
  await assert.rejects(scanRange(browser, settings, { delay: async () => {} }), { code: 'week_mismatch', message: /Range incomplete \(1\/2 weeks checked\)/ });
});

test('unknown cells remain partial even when all weeks load', async () => {
  let target;
  const browser = { selectDate: async date => { target = date; }, check: async () => { const value = fakeCalendar(target); value.slots[5].availability = 'unknown'; return value; } };
  const result = await scanRange(browser, settings, { delay: async () => {} });
  assert.equal(result.status, 'partial'); assert.equal(result.unknown, 1);
});

test('cancel between weeks prevents further navigation and rejects incomplete scan', async () => {
  const controller = new AbortController();
  let selected = 0;
  const browser = { selectDate: async () => { selected++; }, check: async () => fakeCalendar('2026-12-05') };
  await assert.rejects(scanRange(browser, settings, { signal: controller.signal, delay: async () => controller.abort() }), { code: 'scan_cancelled' });
  assert.equal(selected, 1);
});

test('failed range preserves the previous full snapshot and alert history', async () => {
  const browser = { selectDate: async () => { throw new AppError('session_expired', 'Login required.'); } };
  const monitor = new Monitor(browser, settings);
  const previous = { matches: [{ date: '2026-12-04', time: '08:30' }] };
  monitor.result = previous; monitor.previous.add('known-slot');
  await monitor.start();
  assert.equal(monitor.result, previous); assert.ok(monitor.previous.has('known-slot'));
  assert.equal(monitor.running, false); assert.equal(monitor.lastError.code, 'session_expired');
});

test('watch pauses on the matching week, keeps the browser open, and next skips it', async () => {
  let target;
  let focused = 0;
  const selected = [];
  const browser = {
    selectDate: async date => { target = date; selected.push(date); },
    check: async () => fakeCalendar(target), focus: async () => { focused++; },
    close: async () => assert.fail('The browser must stay open for manual booking'),
  };
  const monitor = new Monitor(browser, settings);
  await monitor.start();
  assert.equal(monitor.running, false); assert.equal(monitor.waitingForBooking, true);
  assert.equal(monitor.nextCheck, null); assert.equal(focused, 1);
  assert.deepEqual(selected, ['2026-12-05']);
  assert.equal(monitor.result.scanComplete, false); assert.equal(monitor.result.weeksChecked, 1);
  await monitor.continueAfterMatch();
  assert.deepEqual(selected, ['2026-12-05', '2026-12-12']);
  assert.ok(monitor.skippedWeeks.has('2026-11-30'));
  assert.equal(monitor.waitingForBooking, true); assert.equal(focused, 2);
  await monitor.continueAfterMatch();
  assert.equal(selected.length, 2); assert.equal(monitor.running, true);
  assert.equal(monitor.waitingForBooking, false); assert.equal(monitor.result.weeksChecked, 0);
  assert.equal(monitor.result.skippedWeeks.length, 2);
  monitor.stop();
});

test('restart clears rejected weeks and rechecks from the start', async () => {
  let target;
  let prepared = 0;
  const selected = [];
  const browser = {
    prepare: async () => { prepared++; return { message: 'Ready.' }; },
    selectDate: async date => { target = date; selected.push(date); }, check: async () => fakeCalendar(target),
  };
  const monitor = new Monitor(browser, settings);
  await monitor.start();
  await monitor.continueAfterMatch();
  assert.equal(monitor.skippedWeeks.size, 1);
  await monitor.restart();
  assert.equal(prepared, 1); assert.equal(monitor.skippedWeeks.size, 0);
  assert.equal(selected.at(-1), '2026-12-05');
  assert.equal(monitor.waitingForBooking, true); assert.equal(monitor.nextCheck, null);
});

test('only slots matching date/time filters pause the scan', async () => {
  let target;
  const selected = [];
  const browser = { selectDate: async date => { target = date; selected.push(date); }, check: async () => {
    const value = fakeCalendar(target);
    if (target === '2026-12-05') for (const slot of value.slots) slot.time = '06:00';
    return value;
  } };
  const result = await scanRange(browser, settings, { pauseOnMatch: true, delay: async () => {} });
  assert.deepEqual(selected, ['2026-12-05', '2026-12-12']);
  assert.equal(result.pausedOnMatch, true);
});

test('once scans all weeks even when pause-on-match is configured', async () => {
  let target;
  const browser = { selectDate: async date => { target = date; }, check: async () => fakeCalendar(target) };
  const monitor = new Monitor(browser, { ...settings, scanDelaySeconds: 0 });
  await monitor.check();
  assert.equal(monitor.result.weeksChecked, 2); assert.equal(monitor.result.matches.length, 7);
  assert.equal(monitor.waitingForBooking, false); assert.equal(monitor.result.scanComplete, true);
});

test('single-day ranges pause on matching slots and can opt out', async () => {
  const browser = { selectDate: async () => {}, check: async () => fakeCalendar('2026-12-05') };
  const singleDay = { ...settings, dateTo: settings.dateFrom };
  const paused = new Monitor(browser, singleDay);
  await paused.start(); assert.equal(paused.waitingForBooking, true); assert.equal(paused.nextCheck, null);
  const continuous = new Monitor(browser, { ...singleDay, pauseOnMatch: false });
  await continuous.start(); assert.equal(continuous.running, true); assert.equal(continuous.waitingForBooking, false); continuous.stop();
});
