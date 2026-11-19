import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { RtdBrowser } from '../src/browser.js';
import { defaults } from '../src/settings.js';
import { calendar, observedCalendar } from './fixtures.js';

let chrome;
before(async () => { chrome = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await chrome?.close(); });

const origin = 'https://rtd.mcw.gov.cy';
const calendarUrl = `${origin}/WebPhase1/gui/Driver/NewCalendar1.jsp`;
const slotPage = () => calendar({ backgrounds: { '0:4': 'greentime.gif' } })
  .replace('action="../../ExaminerDateServlet"', 'action="/WebPhase1/ExaminerDateServlet"')
  .replace('value="04/12/2026"', 'value="05/12/2026"')
  .replace('<table>', `<input name="licencecategory" value="BB%04/12/2026" type="hidden">
    <table><tr><td>Δεκέμβριος 2026</td></tr></table>
    <a href="" onclick="document.forms.vrmSearch.submit(); return false;">5</a><table>`);

async function harness(t, status = 200, headers = {}) {
  const context = await chrome.newContext();
  t.after(() => context.close());
  const browser = new RtdBrowser();
  context.on('response', response => browser.observeResponse(response));
  const requests = [];
  // Every request is intercepted; these tests cannot contact RTD or book.
  await context.route('**/*', async route => {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.abort();
    requests.push({ url: request.url(), method: request.method(), body: request.postData() });
    if (request.url() === `${origin}/test`) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<iframe src="${calendarUrl}"></iframe>` });
    if (request.url() === calendarUrl) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: slotPage() });
    if (request.url() === `${origin}/WebPhase1/ExaminerDateServlet`) {
      const current = typeof status === 'function' ? status() : status;
      return route.fulfill({ status: current, headers, contentType: 'text/html; charset=utf-8', body: current === 200 ? slotPage() : '<h1>Request rejected</h1>' });
    }
    return route.abort();
  });
  browser.page = await context.newPage();
  await browser.page.goto(`${origin}/test`);
  return { browser, requests };
}

test('429 recovery repeats only the rejected calendar POST and reads the restored visible page', async t => {
  const statuses = [429, 429, 200];
  const { browser, requests } = await harness(t, () => statuses.shift());
  await assert.rejects(browser.selectDate('2026-12-05'), { code: 'rate_limited' });
  await assert.rejects(browser.selectDate('2026-12-05'), { code: 'rate_limited' });
  await browser.selectDate('2026-12-05');
  assert.equal((await browser.check(defaults)).available, 1);
  assert.equal(requests.filter(r => r.method === 'POST').length, 3);
  const posts = requests.filter(r => r.method === 'POST');
  assert.equal(posts[1].body, posts[0].body);
  assert.equal(posts[2].body, posts[0].body);
  assert.equal(requests.length, 5); // outer page + initial frame + three POSTs
});

test('429 recovery honors server deadline and stops if access becomes forbidden', async t => {
  const statuses = [429, 403];
  const { browser, requests } = await harness(t, () => statuses.shift(), { 'retry-after': '7200' });
  await assert.rejects(browser.selectDate('2026-12-05'), { code: 'rate_limited' });
  const count = requests.length;
  await assert.rejects(browser.selectDate('2026-12-05'), { code: 'rate_limited' });
  assert.equal(requests.length, count);
  t.mock.timers.enable({ apis: ['Date'], now: browser.accessError.retryAt });
  await assert.rejects(browser.selectDate('2026-12-05'), { code: 'access_denied' });
});

test('429 without a recoverable calendar request stops rather than replaying another operation', async t => {
  const { browser } = await harness(t, 429);
  await assert.rejects(browser.selectDate('2026-12-05'), { code: 'rate_limited' });
  browser.calendarRetry = null;
  await assert.rejects(browser.selectDate('2026-12-05'), { code: 'manual_step' });
});

test('one calendar POST loads the displayed slots; reading them sends no requests', async t => {
  const { browser, requests } = await harness(t);
  await browser.selectDate('2026-12-05');
  const before = requests.length;
  const result = await browser.check(defaults);
  assert.equal(result.available, 1);
  assert.equal(result.slots.find(slot => slot.availability === 'available').date, '2026-12-04');
  assert.equal(requests.length, before);
  assert.equal(requests.filter(request => request.method === 'POST').length, 1);
  const frame = await browser.findFrame('form[name="vrmSearch"]');
  assert.equal(await frame.locator('td[background$="greentime.gif"]').count(), 1);
  await assert.rejects(browser.check({ ...defaults, centre: '2' }), { code: 'context_mismatch' });
  await assert.rejects(browser.check({ ...defaults, category: 'A' }), { code: 'context_mismatch' });
});

for (const [status, code] of [[429, 'rate_limited'], [403, 'access_denied'], [401, 'session_expired']]) {
  test(`HTTP ${status} stops navigation without reading an error page as a calendar or retrying`, async t => {
    const { browser, requests } = await harness(t, status, { 'retry-after': '900' });
    await assert.rejects(browser.selectDate('2026-12-05'), { code });
    const count = requests.length;
    await assert.rejects(browser.check(defaults), { code });
    await assert.rejects(browser.prepare(defaults), { code });
    assert.equal(requests.length, count);
  });
}

const observedCalendarUrl = `${origin}/WebPhase1/gui/dlcalendar/NewCalendar1.jsp`;
async function selectionHarness(t, { background = 'bluetimeover.gif', status = 200, change = html => html } = {}) {
  const context = await chrome.newContext({ serviceWorkers: 'block' });
  context.setDefaultTimeout(2000);
  t.after(() => context.close());
  const browser = new RtdBrowser();
  browser.context = context;
  context.on('response', r => browser.observeResponse(r));
  const requests = [];
  await context.route('**/*', async route => {
    const req = route.request();
    requests.push({ method: req.method(), path: new URL(req.url()).pathname });
    if (req.url() === `${origin}/selection-test`) return route.fulfill({ contentType: 'text/html', body: `<iframe name="center" src="${observedCalendarUrl}"></iframe>` });
    if (req.url() === observedCalendarUrl) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: observedCalendar(background) });
    if (new URL(req.url()).pathname === '/WebPhase1/gui/dlcalendar/NewCalendar3.jsp') {
      return route.fulfill({ status, headers: status === 429 ? { 'retry-after': '900' } : {}, contentType: 'text/html; charset=utf-8', body: change(`<form name="vrmSearch" method="post" action="../../ProcessOnlineTestPayment?lang=null">
        <input type="hidden" name="h_centre" value="1"><input type="hidden" name="licencecategory" value="ΒΒ">
        <input type="hidden" name="h_test_date" value="04/12/26"><input type="hidden" name="h_test_time" value="13:45">
        <div class="g-recaptcha" onclick="window.captchaClicked=true"></div>
        <input id="submitBtn" type="button" value="Payment" disabled onclick="this.form.submit()">
      </form>`) });
    }
    return route.abort();
  });
  browser.page = await context.newPage();
  await browser.page.goto(`${origin}/selection-test`);
  const settings = { ...defaults, dateFrom: '2026-12-04', dateTo: '2026-12-31' };
  const slot = (await browser.check(settings)).slots.find(s => s.availability === 'available');
  return { browser, requests, settings, slot };
}

for (const background of ['timeregular3.gif', 'bluetimeover.gif']) {
  test(`${background}: one selection GET then stop; next restores calendar without a payment request`, async t => {
    const { browser, requests, settings, slot } = await selectionHarness(t, { background });
    const before = requests.length;
    await browser.selectSlot(slot, settings);
    assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1).method, 'GET');
    const frame = browser.selection.frame;
    assert.equal(await frame.locator('#submitBtn').isDisabled(), true);
    assert.equal(await frame.evaluate(() => Boolean(window.captchaClicked)), false);
    await browser.returnToCalendar(settings);
    assert.equal((await browser.check(settings)).available, 1);
    assert.equal(browser.selection, null);
    assert.equal(requests.some(r => r.path.includes('ProcessOnlineTestPayment')), false);
  });
}

test('already enabled payment button is never clicked', async t => {
  const { browser, requests, settings, slot } = await selectionHarness(t, { change: html => html.replace(' disabled', '') });
  await browser.selectSlot(slot, settings);
  assert.equal(await browser.selection.frame.locator('#submitBtn').isDisabled(), false);
  assert.equal(requests.some(r => r.method === 'POST'), false);
});

test('changed slot and cancellation stop before the selection request', async t => {
  const { browser, requests, settings, slot } = await selectionHarness(t);
  const before = requests.length;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(browser.selectSlot(slot, settings, { signal: controller.signal }), { code: 'scan_cancelled' });
  const frame = await browser.findFrame('form[name="vrmSearch"]');
  await frame.locator('td[background$="bluetimeover.gif"] a').evaluate(a => a.removeAttribute('href'));
  await assert.rejects(browser.selectSlot(slot, settings), { code: 'slot_changed' });
  assert.equal(requests.length, before);
});

for (const [label, change] of [
  ['date', html => html.replace('04/12/26', '05/12/26')],
  ['centre', html => html.replace('name="h_centre" value="1"', 'name="h_centre" value="2"')],
  ['category', html => html.replace('value="ΒΒ"', 'value="A"')],
  ['time', html => html.replace('13:45', '14:30')],
  ['form action', html => html.replace('ProcessOnlineTestPayment', 'OtherServlet')],
  ['missing CAPTCHA', html => html.replace('g-recaptcha', 'other-widget')],
]) {
  test(`mismatching ${label} on the next screen cannot count as a successful handoff`, async t => {
    const { browser, requests, settings, slot } = await selectionHarness(t, { change });
    await assert.rejects(browser.selectSlot(slot, settings), { code: 'handoff_failed' });
    assert.equal(requests.filter(r => r.path.endsWith('NewCalendar3.jsp')).length, 1);
    assert.equal(requests.some(r => r.method === 'POST'), false);
  });
}

test('selection HTTP 429 is not retained for calendar replay', async t => {
  const { browser, requests, settings, slot } = await selectionHarness(t, { status: 429 });
  await assert.rejects(browser.selectSlot(slot, settings), { code: 'rate_limited' });
  assert.equal(browser.calendarRetry, null);
  assert.equal(requests.filter(r => r.path.endsWith('NewCalendar3.jsp')).length, 1);
});

for (const command of ['returnToCalendar', 'prepare']) {
  test(`${command} leaves selection 429 after the deadline without replaying selection`, async t => {
    const { browser, requests, settings, slot } = await selectionHarness(t, { status: 429 });
    await assert.rejects(browser.selectSlot(slot, settings), { code: 'rate_limited' });
    const count = requests.length;
    await assert.rejects(browser[command](settings), { code: 'rate_limited' });
    assert.equal(requests.length, count);
    t.mock.timers.enable({ apis: ['Date'], now: browser.accessError.retryAt + 1 });
    await browser[command](settings);
    assert.equal(browser.accessError, null);
    assert.equal(browser.selection, null);
    assert.equal((await browser.check(settings)).available, 1);
    assert.equal(requests.filter(r => r.path.endsWith('NewCalendar3.jsp')).length, 1);
    assert.equal(requests.some(r => r.method === 'POST'), false);
  });
}

test('explicit recovery accepts a calendar already restored manually after selection 429', async t => {
  const { browser, requests, settings, slot } = await selectionHarness(t, { status: 429 });
  await assert.rejects(browser.selectSlot(slot, settings), { code: 'rate_limited' });
  t.mock.timers.enable({ apis: ['Date'], now: browser.accessError.retryAt + 1 });
  const frame = browser.selection.frame;
  await frame.goto(observedCalendarUrl);
  const count = requests.length;
  await browser.returnToCalendar(settings);
  assert.equal(browser.selection, null);
  assert.equal(browser.accessError, null);
  assert.equal(requests.length, count);
});

for (const status of [401, 403, 429]) {
  test(`return cannot clear a newer HTTP ${status} from a different operation`, async t => {
    const { browser, settings, slot } = await selectionHarness(t, { status: 429 });
    await assert.rejects(browser.selectSlot(slot, settings), { code: 'rate_limited' });
    t.mock.timers.enable({ apis: ['Date'], now: browser.accessError.retryAt + 1 });
    await browser.context.route(observedCalendarUrl, route => route.fulfill({ status, body: 'Access error' }));
    await browser.selection.frame.goto(observedCalendarUrl);
    const latestError = browser.accessError;
    await assert.rejects(browser.returnToCalendar(settings), { code: latestError.code });
    assert.equal(browser.accessError, latestError);
    assert.ok(browser.selection);
  });
}

test('return refuses a page beyond selection and retains manual inspection state', async t => {
  const { browser, settings, slot } = await selectionHarness(t);
  await browser.selectSlot(slot, settings);
  const selection = browser.selection;
  await browser.context.route(`${origin}/manual-payment`, route => route.fulfill({ body: 'Manual payment page' }));
  await selection.frame.goto(`${origin}/manual-payment`);
  await assert.rejects(browser.prepare(settings), { code: 'manual_step' });
  assert.equal(browser.selection, selection);
  assert.equal(selection.frame.url(), `${origin}/manual-payment`);
  assert.equal(browser.page.isClosed(), false);
});
