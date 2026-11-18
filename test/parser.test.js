import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendar, filterSlots, isoDate } from '../src/parser.js';
import { calendar, dates } from './fixtures.js';
import { defaults } from '../src/settings.js';

test('all-red nested weekly grid is parsed once with correct dates', () => {
  const result = parseCalendar(calendar(), { expectedDate: '2026-12-04' });
  assert.equal(result.status, 'ok');
  assert.equal(result.unavailable, 72);
  assert.equal(result.available, 0);
  assert.deepEqual(result.slots[0], { date: '2026-11-30', time: '07:45', availability: 'unavailable', background: 'redtime.gif', hasAction: false });
  assert.equal(result.slots.at(-1).date, '2026-12-05');
});
test('green slots map to weekday and normalize time; inclusive filtering', () => {
  const result = parseCalendar(calendar({ backgrounds: { '0:4': 'greentime.gif', '11:5': 'greentime.gif' } }));
  assert.equal(result.available, 2);
  assert.deepEqual(filterSlots(result.slots, { ...defaults, dateFrom: '2026-12-04', dateTo: '2026-12-04', timeTo: '07:45' }).map(({ date, time }) => ({ date, time })), [{ date: '2026-12-04', time: '07:45' }]);
});
test('legacy uppercase attributes parse like browser HTML', () => {
  const html = calendar({ backgrounds: { '0:4': 'greentime.gif' } }).replaceAll('background=', 'BACKGROUND=').replaceAll('name=', 'NAME=');
  const result = parseCalendar(html, { expectedDate: '2026-12-04' });
  assert.equal(result.slots.length, 72);
  assert.equal(result.available, 1);
  assert.equal(result.unavailable, 71);
});
test('unverified blue and arbitrary backgrounds are unknown, not occupied', () => {
  const result = parseCalendar(calendar({ backgrounds: { '0:0': 'bluetime.gif', '1:0': 'changed.gif' } }));
  assert.equal(result.status, 'partial'); assert.equal(result.unknown, 2);
  assert.equal(result.unavailable, 70); assert.equal(result.available, 0);
});
test('login, HTTP errors and unexpected HTML are errors rather than no slots', () => {
  assert.throws(() => parseCalendar('<form><input type="password"></form>'), { code: 'session_expired' });
  assert.throws(() => parseCalendar('<h1>Maintenance</h1>'), { code: 'unexpected_response' });
  assert.throws(() => parseCalendar(calendar(), { status: 503 }), { code: 'http_error' });
  assert.throws(() => parseCalendar('<form name="vrmSearch"></form>'), { code: 'unexpected_response' });
});
test('stale week is rejected even when the date field claims another week', () => {
  assert.throws(() => parseCalendar(calendar(), { expectedDate: '2026-12-11' }), { code: 'week_mismatch' });
});
test('truncated rows and nonsequential dates fail closed', () => {
  assert.throws(() => parseCalendar(calendar({ omit: '0:2' })), { code: 'unexpected_response' });
  assert.throws(() => parseCalendar(calendar({ headers: [...dates.slice(0, 5), dates[0]] })), { code: 'unexpected_response' });
  assert.throws(() => parseCalendar(calendar({ headers: [...dates.slice(0, 5), '07/12/26'] })), { code: 'unexpected_response' });
});
test('dates reject invalid days and handle leap years', () => {
  assert.equal(isoDate('31/02/2026'), null); assert.equal(isoDate('01/01/27'), '2027-01-01'); assert.equal(isoDate('29/02/2028'), '2028-02-29');
});
