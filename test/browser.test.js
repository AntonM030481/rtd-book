import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { RtdBrowser } from '../src/browser.js';
import { defaults } from '../src/settings.js';
import { calendar } from './fixtures.js';

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
