import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendar, filterSlots, isoDate } from '../src/parser.js';
import { calendar, dates, observedCalendar } from './fixtures.js';
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
test('observed free-slot link must agree with the date, time, centre and category', () => {
  const href = 'NewCalendar3.jsp?examtime=13:45+&amp;nameDay=3&amp;calendarday=04/12/26&amp;h_centre=2&amp;licencecategory=ΒΒ&amp;lang=null';
  // Minimal non-personal reproduction of the observed 4 December 13:45 cell.
  const html = calendar({ backgrounds: { '7:4': 'timeregular3.gif' } })
    .replace('name="h_centre" value="1"', 'name="h_centre" value="2"')
    .replace('<table>', '<input type="hidden" name="licencecategory" value="ΒΒ"><table>')
    .replace('<td background="/WebPhase1/images/drivercalendar/timeregular3.gif"><h5>13:45</h5></td>',
      `<td background="/WebPhase1/images/drivercalendar/timeregular3.gif"><a href="${href}" target="center"><h5>13:45</h5></a></td>`);
  const result = parseCalendar(html);
  assert.equal(result.available, 1);
  assert.equal(result.unknown, 0);
  assert.deepEqual(filterSlots(result.slots, { ...defaults, dateFrom: '2026-12-04', dateTo: '2026-12-04' })
    .map(({ date, time, hasAction }) => ({ date, time, hasAction })), [{ date: '2026-12-04', time: '13:45', hasAction: true }]);
  for (const [from, to] of [
    ['NewCalendar3.jsp', 'unknown.jsp'], ['NewCalendar3.jsp', 'https://example.com/NewCalendar3.jsp'],
    ['examtime=13:45+', 'examtime=12:15'], ['calendarday=04/12/26', 'calendarday=05/12/26'],
    ['h_centre=2', 'h_centre=1'], ['licencecategory=ΒΒ', 'licencecategory=A'],
    [`href="${href}"`, ''],
  ]) {
    const changed = parseCalendar(html.replace(from, to));
    assert.equal(changed.available, 0);
    assert.equal(changed.unknown, 1);
  }
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

for (const background of ['timeregular3.gif', 'bluetimeover.gif']) {
  test(`observed ${background} exposes a validated selection link and fee type`, () => {
    const html = observedCalendar(background);
    const result = parseCalendar(html);
    const slot = result.slots.find(s => s.availability === 'available');
    assert.equal(result.available, 1);
    assert.equal(result.unknown, 0);
    assert.equal(slot.overtime, background === 'bluetimeover.gif');
    assert.match(slot.selectionHref, /^NewCalendar3\.jsp\?/);
    for (const changed of [html.replace('h_centre=1', 'h_centre=2'), html.replace('examtime=13:45+', 'examtime=13:45+&amp;examtime=12:15'), html.replace('href=', 'data-href=')]) {
      assert.equal(parseCalendar(changed).available, 0);
      assert.equal(parseCalendar(changed).unknown, 1);
    }
  });
}
