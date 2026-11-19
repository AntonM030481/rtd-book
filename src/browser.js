import { chromium } from 'playwright';
import { join } from 'node:path';
import { config, root } from './config.js';
import { AppError, httpError } from './errors.js';
import { filterSlots, isoDate, parseCalendar } from './parser.js';

const origin = 'https://rtd.mcw.gov.cy';
const entry = `${origin}/WebPhase1/gui/Common/LoginFrameGreek.jsp?lang=en`;
const categoryKey = value => value.split('%')[0].trim().toUpperCase().replaceAll('Β', 'B');

export class RtdBrowser {
  context = null;
  page = null;
  accessError = null;
  calendarRetry = null;
  lastAccessResponse = null;
  selection = null;

  observeResponse(response) {
    // Observe existing document traffic only; never issue a diagnostic request.
    if (!response.request().isNavigationRequest() || new URL(response.url()).origin !== origin) return;
    if (![401, 403, 429].includes(response.status()) || this.lastAccessResponse === response) return;
    this.lastAccessResponse = response;
    if (this.accessError && this.accessError.code !== 'rate_limited') return;
    this.accessError = httpError(response.status(), response.headers()['retry-after'] || '');
    this.calendarRetry = null;
    const request = response.request();
    if (response.status() === 429 && this.selection && response.frame() === this.selection.frame
      && response.url() === this.selection.detailUrl && request.method() === 'GET') {
      this.selection.rateLimitError = this.accessError;
    }
    // Retain only the rejected read-only calendar request, in memory. Never
    // replay login, booking, payment, or an unfamiliar endpoint.
    if (response.status() === 429 && request.method() === 'POST'
      && new URL(request.url()).pathname === '/WebPhase1/ExaminerDateServlet'
      && request.headers()['content-type']?.startsWith('application/x-www-form-urlencoded')) {
      const body = request.postData();
      const date = isoDate(new URLSearchParams(body).get('asd') || '');
      if (date) this.calendarRetry = { frame: response.frame(), url: response.url(), body, date };
    }
  }

  assertAccess() { if (this.accessError) throw this.accessError; }

  async recoverCalendar() {
    const error = this.accessError;
    if (error?.code !== 'rate_limited') { this.assertAccess(); return null; }
    if (error.retryAt > Date.now()) throw error;
    const retry = this.calendarRetry;
    if (!retry || retry.frame.isDetached() || retry.frame.url() !== retry.url) {
      throw new AppError('manual_step', 'The rate-limited calendar cannot be restored safely. Check the RTD window and restart manually.');
    }
    this.accessError = null;
    this.calendarRetry = null;
    let response;
    try {
      [response] = await Promise.all([
        retry.frame.waitForNavigation({ waitUntil: 'load', timeout: 20000 }),
        retry.frame.evaluate(({ url, body }) => {
          if (location.href !== url) throw new Error('The calendar page changed.');
          const form = document.createElement('form');
          form.method = 'post';
          form.acceptCharset = 'UTF-8';
          form.action = url;
          for (const [name, value] of new URLSearchParams(body)) {
            const input = document.createElement('input');
            input.type = 'hidden'; input.name = name; input.value = value;
            form.append(input);
          }
          document.body.append(form);
          HTMLFormElement.prototype.submit.call(form);
        }, { url: retry.url, body: retry.body }),
      ]);
    } catch {
      this.assertAccess();
      throw new AppError('manual_step', 'Calendar recovery failed. Check the RTD window and restart manually.');
    }
    await this.validateCalendarResponse(response);
    await this.waitCalendarDate(retry.frame, retry.date);
    return retry.date;
  }

  async validateCalendarResponse(response) {
    if (!response) throw new AppError('week_mismatch', 'The date did not load a new calendar document.');
    if (new URL(response.url()).origin !== origin) throw new AppError('unexpected_action', 'The calendar navigated outside RTD.');
    this.observeResponse(response);
    this.assertAccess();
    const failure = httpError(response.status(), response.headers()['retry-after'] || '');
    if (failure) throw failure;
    if (await this.findFrame('input[type="password"]')) throw new AppError('session_expired', 'The RTD session expired. Restart the app.');
  }

  async open() {
    this.assertAccess();
    if (!this.context) {
      try {
        this.context = await chromium.launchPersistentContext(join(root, '.local', 'browser'), {
          channel: config.browserChannel, headless: false, viewport: null,
          acceptDownloads: false, timeout: 30000,
        });
        this.context.on('close', () => { this.context = null; this.page = null; });
        this.context.setDefaultTimeout(12000);
        this.context.on('response', response => this.observeResponse(response));
      } catch {
        throw new AppError('browser_unavailable', 'Could not open Chrome. Close the previous app browser and check that Chrome is installed.');
      }
    }
    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages().find(page => page.url().startsWith(origin)) || await this.context.newPage();
      if (!this.page.url().startsWith(origin)) {
        try { await this.page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
        catch (error) {
          this.assertAccess();
          const networkCode = /net::[A-Z_]+/.exec(error.message)?.[0];
          throw new AppError('navigation_failed', `Could not load RTD${networkCode ? ` (${networkCode})` : ''}. Check the network and browser window, then restart the app.`);
        }
      }
    }
    this.assertAccess();
    await this.page.bringToFront();
  }

  frames() {
    return (this.page && !this.page.isClosed() ? this.page.frames() : [])
      .filter(frame => { try { return new URL(frame.url()).origin === origin; } catch { return false; } });
  }

  async findFrame(selector) {
    this.assertAccess();
    for (const frame of this.frames()) {
      try { if (await frame.locator(selector).count()) return frame; } catch { /* frame navigated */ }
    }
    return null;
  }

  async waitFrame(selector, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const frame = await this.findFrame(selector);
      if (frame) return frame;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return null;
  }

  async prepare(settings) {
    await this.returnToCalendar(settings);
    await this.open();
    // A single credential submission per explicit prepare action. Never retry
    // a rejected login in the monitoring loop.
    const passwordFrame = await this.waitForLoginOrAccount();
    if (passwordFrame) {
      if (!config.username || !config.password) throw new AppError('credentials_missing', 'Set RTD_USER and RTD_PASS in .env and restart, or sign in manually in RTD.');
      const password = passwordFrame.locator('input[type="password"]').filter({ visible: true });
      const form = passwordFrame.locator('form').filter({ has: password });
      const username = form.locator('input:not([type]), input[type="text"], input[type="email"]').filter({ visible: true });
      if (await form.count() !== 1 || await username.count() !== 1 || await password.count() !== 1) {
        throw new AppError('manual_step', 'The login form is unfamiliar. Sign in manually in RTD and restart the app.');
      }
      await username.fill(config.username);
      await password.fill(config.password);
      await password.press('Enter');
      if (!await this.waitFrame('a[href*="type=driverLicenseInd"], form[name="vrmSearch"], select[name="h_centre"]')) {
        throw new AppError('login_required', 'Login was not confirmed. Check the RTD window. Automatic login retries are disabled.');
      }
    }
    if (await this.findFrame('form[name="vrmSearch"]')) {
      return { message: 'The calendar is already open. Select the required week, then check availability.' };
    }
    let frame = await this.findFrame('select[name="h_centre"]');
    if (!frame) {
      let menu = await this.findFrame('a[href*="PersonalDataPage.jsp"][href*="comingfrom=1"]');
      if (!menu) {
        const navigation = await this.findFrame('a[href*="type=driverLicenseInd"]');
        if (!navigation) throw new AppError('manual_step', 'Open the Driver License Exam section in RTD.');
        await navigation.locator('a[href*="type=driverLicenseInd"]').first().click();
        menu = await this.waitFrame('a[href*="PersonalDataPage.jsp"][href*="comingfrom=1"]');
      }
      if (!menu) throw new AppError('manual_step', 'The booking menu was not found. Continue in the RTD window.');
      await menu.locator('a[href*="PersonalDataPage.jsp"][href*="comingfrom=1"]').first().click();
      frame = await this.waitFrame('select[name="h_centre"]');
    }
    if (!frame) throw new AppError('manual_step', 'Complete the intermediate step in RTD, then restart the app.');
    if (!config.plate) throw new AppError('plate_missing', 'Set RTD_PLATE_NUMBER in .env and restart the app.');
    const category = frame.locator('select[name="h_licence_category"]');
    const options = await category.locator('option').evaluateAll(elements => elements.map(el => ({ text: el.textContent.trim(), value: el.value })));
    const selected = options.find(option => categoryKey(option.text) === categoryKey(settings.category));
    if (!selected) throw new AppError('category_unavailable', 'The configured category is not available in this account. Check the RTD dropdown.');
    await frame.locator('select[name="h_centre"]').selectOption(settings.centre);
    await category.selectOption(selected.value);
    await frame.locator('input[name="h_vrm"]').fill(config.plate);
    await frame.locator('#submitBtn').click();
    const calendar = await this.waitFrame('form[name="vrmSearch"]');
    return { message: calendar
      ? 'The calendar is ready. Select a week in RTD and check availability.'
      : 'Details are filled in. Complete the date selection in RTD to open the weekly calendar.' };
  }

  async waitForLoginOrAccount() {
    for (let attempt = 0; attempt < 40; attempt++) {
      const login = await this.findFrame('input[type="password"]');
      if (login) return login;
      if (await this.findFrame('a[href*="type=driverLicenseInd"], form[name="vrmSearch"], select[name="h_centre"]')) return null;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new AppError('manual_step', 'RTD is not ready. Check the browser and complete login manually if needed.');
  }

  async check(settings) {
    const frame = await this.findFrame('form[name="vrmSearch"]');
    if (!frame) {
      if (await this.findFrame('input[type="password"]')) throw new AppError('session_expired', 'The RTD session expired. Restart the app.');
      throw new AppError('calendar_missing', 'The weekly calendar is missing. Restart the app to prepare it.');
    }
    const result = await frame.evaluate(({ expectedOrigin, centre, category }) => {
      const form = document.forms.namedItem('vrmSearch');
      if (!form) return { error: 'calendar_missing' };
      const url = new URL(form.action, location.href);
      if (url.origin !== expectedOrigin || !url.pathname.endsWith('/ExaminerDateServlet') || form.method.toLowerCase() !== 'post') return { error: 'unexpected_action' };
      const data = new FormData(form);
      const centres = data.getAll('h_centre').map(String).filter(Boolean);
      const rawCategory = String(data.get('licencecategory') || '');
      const normalize = value => value.split('%')[0].trim().toUpperCase().replaceAll('Β', 'B');
      if (!centres.length || centres.some(value => value !== centre) || !rawCategory || normalize(rawCategory) !== normalize(category)) return { error: 'context_mismatch' };
      const date = form.elements.namedItem('asd')?.value;
      if (!date) return { error: 'date_missing' };
      // Read one snapshot of the displayed document. Do not fetch a newer,
      // invisible calendar that could disagree with the page used for booking.
      // Raw HTML stays in memory because it may contain personal form fields.
      return { html: document.documentElement.outerHTML, date };
    }, { expectedOrigin: origin, centre: settings.centre, category: settings.category });
    const messages = {
      calendar_missing: 'The calendar form is no longer available. Open it again.',
      unexpected_action: 'The form action or method is not recognized.',
      context_mismatch: 'The calendar centre or category does not match .env. Select the correct values in RTD.',
      date_missing: 'The selected date could not be identified. No request was sent.',
    };
    this.assertAccess();
    if (result.error) throw new AppError(result.error, messages[result.error]);
    const expectedDate = isoDate(result.date);
    if (!expectedDate) throw new AppError('date_missing', 'The calendar date was not recognized.');
    return { ...parseCalendar(result.html, { expectedDate }), centre: settings.centre, category: settings.category };
  }

  async selectDate(date) {
    try { return await this.selectCalendarDate(date); }
    catch (error) {
      if (error instanceof AppError) throw error;
      this.assertAccess();
      // This operation uses only calendar selectors and a date, never credentials.
      throw new AppError('date_selection_failed', `Could not select the calendar date: ${String(error.message).split('\n')[0].slice(0, 180)}`);
    }
  }

  async selectCalendarDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw new AppError('invalid_date', 'The date must be a valid YYYY-MM-DD value.');
    }
    if (this.accessError?.code === 'rate_limited' && await this.recoverCalendar() === date) return;
    const frame = await this.findFrame('form[name="vrmSearch"]');
    if (!frame) throw new AppError('calendar_missing', 'The weekly calendar must be open before selecting a date.');
    const target = new Date(`${date}T00:00:00Z`);
    if (target.getUTCDay() === 0) throw new AppError('invalid_date', 'RTD displays Monday through Saturday. Select one of those days.');
    const monthNames = ['ιανουαριος', 'φεβρουαριος', 'μαρτιος', 'απριλιος', 'μαιος', 'ιουνιος', 'ιουλιος', 'αυγουστος', 'σεπτεμβριος', 'οκτωβριος', 'νοεμβριος', 'δεκεμβριος'];
    const targetMonth = target.getUTCFullYear() * 12 + target.getUTCMonth();
    const readMonth = () => frame.evaluate(names => {
      for (const cell of document.querySelectorAll('td,th')) {
        if (cell.querySelector('table')) continue;
        const text = cell.textContent.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        const match = /^([α-ω]+)\s+(\d{4})$/.exec(text);
        if (match && names.includes(match[1])) return Number(match[2]) * 12 + names.indexOf(match[1]);
      }
      return null;
    }, monthNames);
    let currentMonth = await readMonth();
    if (currentMonth === null || Math.abs(currentMonth - targetMonth) > 24) throw new AppError('manual_step', 'Could not select the month automatically. Select the date in the RTD window.');
    while (currentMonth !== targetMonth) {
      const next = targetMonth > currentMonth;
      await frame.locator(`img[src$="dlcalendar_${next ? 'next' : 'prev'}month_black.gif"]`).click();
      const previous = currentMonth;
      const deadline = Date.now() + 5000;
      do {
        currentMonth = await readMonth();
        if (currentMonth !== previous) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      if (currentMonth === null || currentMonth !== previous + (next ? 1 : -1)) throw new AppError('manual_step', 'The month change was not confirmed. Check the RTD calendar.');
    }
    // The date field changes synchronously, but the site's POST replaces the
    // frame afterward. Await that navigation even within the same week before
    // reading the displayed calendar.
    let response;
    try {
      [response] = await Promise.all([
        frame.waitForNavigation({ waitUntil: 'load', timeout: 20000 }),
        frame.getByRole('link', { name: String(target.getUTCDate()), exact: true }).click(),
      ]);
    } catch {
      this.assertAccess();
      throw new AppError('week_mismatch', 'The date did not load a new calendar document. Check whether RTD allows that date.');
    }
    await this.validateCalendarResponse(response);
    await this.waitCalendarDate(frame, date);
  }

  async waitCalendarDate(frame, date) {
    const fullDate = `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
    const shortDate = `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(2, 4)}`;
    try {
      await frame.waitForFunction(({ fullDate, shortDate }) => {
        const form = document.forms.namedItem('vrmSearch');
        return form?.elements.namedItem('asd')?.value === fullDate && [...document.querySelectorAll('td,th')]
          .some(cell => !cell.querySelector('table') && cell.textContent.trim().endsWith(shortDate));
      }, { fullDate, shortDate }, { timeout: 15000 });
    } catch { throw new AppError('week_mismatch', 'The selected week did not load. Check the RTD window.'); }
  }

  async selectSlot(slot, settings, { signal } = {}) {
    const cancelled = () => { if (signal?.aborted) throw new AppError('scan_cancelled', 'Selection stopped.'); };
    cancelled();
    // Re-read the visible document, without refreshing it or making a fetch.
    const calendar = await this.check(settings);
    const current = filterSlots(calendar.slots, settings).find(item => item.date === slot.date && item.time === slot.time);
    if (!current?.selectionHref || current.selectionHref !== slot.selectionHref) {
      throw new AppError('slot_changed', 'The matching slot no longer has the verified selection link. Check the RTD window.');
    }
    const frame = await this.findFrame('form[name="vrmSearch"]');
    const link = frame.locator(`td[background] a[href=${JSON.stringify(current.selectionHref)}]`);
    if (await link.count() !== 1) throw new AppError('slot_changed', 'The slot link is no longer unique. Check the RTD window.');
    const target = await link.getAttribute('target');
    if (target && target !== '_self' && target !== frame.name()) {
      throw new AppError('unexpected_action', 'The slot targets an unfamiliar browser frame. No selection was made.');
    }
    const detailUrl = new URL(current.selectionHref, frame.url()).href;
    if (new URL(detailUrl).origin !== origin || new URL(detailUrl).pathname !== '/WebPhase1/gui/dlcalendar/NewCalendar3.jsp'
      || await link.evaluate(anchor => anchor.href) !== detailUrl) {
      throw new AppError('unexpected_action', 'The slot link resolves outside the observed selection page.');
    }
    cancelled();
    this.selection = { frame, calendarUrl: frame.url(), detailUrl };
    let response;
    try {
      [response] = await Promise.all([
        frame.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
        link.click({ noWaitAfter: true }),
      ]);
    } catch {
      cancelled();
      this.assertAccess();
      throw new AppError('handoff_failed', 'The selected slot page did not finish loading. No retry was made; inspect the browser.');
    }
    cancelled();
    this.assertAccess();
    if (!response) throw new AppError('handoff_failed', 'No response to slot selection. Inspect the browser before any further action.');
    const error = httpError(response.status(), response.headers()['retry-after'] || '');
    if (error) throw error;
    const details = await frame.evaluate(() => {
      const form = document.forms.namedItem('vrmSearch');
      const button = document.querySelector('#submitBtn');
      if (!form || !button || button.form !== form) return null;
      const data = new FormData(form);
      const value = key => data.getAll(key).length === 1 ? String(data.get(key)) : '';
      return { action: form.action, method: form.method, centre: value('h_centre'), category: value('licencecategory'),
        date: value('h_test_date'), time: value('h_test_time'), buttonType: button.type,
        captchaPresent: Boolean(document.querySelector('.g-recaptcha, iframe[title="reCAPTCHA"], [name="g-recaptcha-response"]')) };
    });
    const action = details && new URL(details.action);
    if (frame.url() !== detailUrl || !details || !await frame.locator('#submitBtn').isVisible()
      || action.origin !== origin || action.pathname !== '/WebPhase1/ProcessOnlineTestPayment'
      || details.method.toLowerCase() !== 'post' || details.buttonType !== 'button' || !details.captchaPresent
      || details.centre !== settings.centre || categoryKey(details.category) !== categoryKey(settings.category)
      || isoDate(details.date) !== slot.date || details.time.trim().padStart(5, '0') !== slot.time) {
      throw new AppError('handoff_failed', 'The next page does not confirm the selected exam and expected CAPTCHA/payment form. Inspect it manually; no further action was taken.');
    }
    // End of automation. Never inspect a CAPTCHA token, click its checkbox,
    // enable the payment button, or submit the payment form.
    return { date: slot.date, time: slot.time, centre: settings.centre, category: settings.category };
  }

  async returnToCalendar(settings) {
    if (!this.selection) return;
    const { frame, calendarUrl, detailUrl } = this.selection;
    if (frame.isDetached() || ![calendarUrl, detailUrl].includes(frame.url())) {
      throw new AppError('manual_step', 'The page changed after slot selection. Check RTD manually before restarting the monitor.');
    }
    const previousError = this.accessError;
    if (previousError?.code === 'rate_limited' && previousError === this.selection.rateLimitError
      && !(previousError.retryAt > Date.now())) {
      // Explicit next/restart may leave a rejected selection after cooldown.
      // Clear only this selection's old 429, never a newer or unrelated error.
      this.accessError = null;
    }
    this.assertAccess();
    try {
      if (frame.url() === detailUrl) {
        // Go back only; never replay the selection GET or payment POST.
        const [response] = await Promise.all([
          frame.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
          frame.evaluate(() => history.back()),
        ]);
        if (response) await this.validateCalendarResponse(response);
      }
      if (frame.url() !== calendarUrl) throw new AppError('manual_step', 'The previous calendar could not be restored. Check the RTD window.');
      await this.check(settings);
      this.selection = null;
    } catch (error) {
      // Failed recovery keeps the selection and any new access restriction.
      this.accessError ||= previousError;
      throw error;
    }
  }

  async focus() { if (this.page && !this.page.isClosed()) await this.page.bringToFront(); }

  async close() { await this.context?.close(); }
}
