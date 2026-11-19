import { AppError, publicError } from './errors.js';
import { filterSlots } from './parser.js';
import { planWeeks, scanRange } from './scan.js';

export class Monitor {
  constructor(browser, settings, { onEvent = () => {}, onResult = () => {} } = {}) {
    this.onEvent = onEvent;
    this.onResult = onResult;
    this.browser = browser;
    this.settings = settings;
    this.running = false;
    this.waitingForBooking = false;
    this.busy = false;
    this.timer = null;
    this.nextCheck = null;
    this.result = null;
    this.lastError = null;
    this.lastAttempt = null;
    this.failures = 0;
    this.retryNotBefore = 0;
    this.events = [];
    this.notificationSeq = 0;
    this.previous = new Set();
    this.abortController = null;
    this.skippedWeeks = new Set();
    this.event('RTD monitor initialized.');
  }

  event(message, level = 'info') {
    this.events.unshift({ at: new Date().toISOString(), message, level });
    this.events = this.events.slice(0, 40);
    this.onEvent(this.events[0]);
  }

  snapshot() {
    return { running: this.running, waitingForBooking: this.waitingForBooking, busy: this.busy, nextCheck: this.nextCheck,
      lastAttempt: this.lastAttempt, lastError: this.lastError, result: this.result,
      settings: this.settings, events: this.events, notificationSeq: this.notificationSeq };
  }

  assertIdle() {
    if (this.busy) throw new AppError('busy', 'Wait for the current operation to finish.');
  }

  assertCooldown() {
    if (Date.now() < this.retryNotBefore) throw new AppError('cooldown', `Waiting until ${new Date(this.retryNotBefore).toISOString()} (UTC) before the next request.`);
  }

  scheduleCheck(deadline) {
    this.nextCheck = new Date(deadline).toISOString();
    // Node timers overflow above ~24.8 days. Long server deadlines must not
    // turn into immediate retries; rearm locally without sending requests.
    const arm = () => {
      this.timer = setTimeout(() => {
        if (!this.running) return;
        if (Date.now() < deadline) arm();
        else void this.check();
      }, Math.min(Math.max(0, deadline - Date.now()), 2147483647));
      this.timer.unref?.();
    };
    arm();
  }

  update(settings) {
    this.assertIdle();
    this.stop(false);
    this.settings = settings;
    this.result = null;
    this.previous.clear();
    this.lastError = null;
    this.event('Settings updated. Monitoring stopped; check the selected week.');
  }

  async prepare() {
    this.assertIdle();
    this.assertCooldown();
    // Keep the manual handoff and its result until preparation succeeds.
    // A refused return must not make the CLI close the user's browser.
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextCheck = null;
    this.busy = true;
    const controller = this.abortController = new AbortController();
    try {
      const outcome = await this.browser.prepare(this.settings);
      if (controller.signal.aborted) throw new AppError('scan_cancelled', 'Preparation stopped.');
      this.waitingForBooking = false;
      this.result = null;
      this.previous.clear();
      this.lastError = null;
      this.event(outcome.message);
      return outcome;
    } catch (error) {
      this.lastError = publicError(error);
      this.event(this.lastError.message, 'error');
      throw error;
    } finally { this.busy = false; this.abortController = null; }
  }

  async check({ afterWeek = null } = {}) {
    this.assertIdle();
    this.assertCooldown();
    clearTimeout(this.timer);
    this.nextCheck = null;
    this.busy = true;
    this.lastAttempt = new Date().toISOString();
    this.abortController = new AbortController();
    try {
      const calendar = await scanRange(this.browser, this.settings, { signal: this.abortController.signal, onProgress: message => this.event(message), pauseOnMatch: this.running && this.settings.pauseOnMatch, skippedWeeks: this.skippedWeeks, afterWeek });
      const matches = filterSlots(calendar.slots, this.settings)
        .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
      const keys = new Set(matches.map(slot => `${calendar.centre}|${calendar.category}|${slot.date}|${slot.time}`));
      const fresh = [...keys].filter(key => !this.previous.has(key));
      if (fresh.length) this.notificationSeq++;
      this.previous = calendar.scanComplete === false || afterWeek ? new Set([...this.previous, ...keys]) : keys;
      this.result = { ...calendar, matches, checkedAt: new Date().toISOString() };
      this.lastError = null;
      this.failures = 0;
      this.retryNotBefore = 0;
      const pause = this.running && this.settings.pauseOnMatch && matches.length > 0;
      if (pause) { this.running = false; this.waitingForBooking = true; }
      this.event(pause
        ? `Matching slots found: ${matches.length}. Monitoring is paused for manual booking.`
        : calendar.status === 'partial'
        ? `Partial result: ${calendar.unknown} unknown cells.`
        : `${afterWeek ? 'Remaining weeks' : 'Range'} checked. Matching slots: ${matches.length}.`, calendar.status === 'partial' ? 'warning' : 'info');
      if (pause) {
        const selected = matches[0];
        this.result.handoff = { status: 'opening', slot: selected };
        this.event(`Opening ${selected.date} ${selected.time}${selected.overtime ? ' (overtime)' : ''}. CAPTCHA and payment will be left to you.`);
        try {
          await this.browser.selectSlot(selected, this.settings, { signal: this.abortController.signal });
          if (this.abortController.signal.aborted) throw new AppError('scan_cancelled', 'Selection stopped.');
          this.result.handoff.status = 'ready';
          this.event('Selected exam confirmed on the CAPTCHA/payment page. Automation is complete; continue manually. This is not a booking confirmation.');
        } catch (error) {
          if (this.abortController.signal.aborted) throw new AppError('scan_cancelled', 'Selection stopped.');
          this.lastError = publicError(error);
          this.result.handoff = { status: 'failed', slot: selected, error: this.lastError };
          // A selection may already have reached RTD. Never automatically retry
          // it, including after HTTP 429, a timeout or an unfamiliar response.
          this.retryNotBefore = Math.max(this.retryNotBefore, this.lastError.retryAt || 0,
            this.lastError.code === 'rate_limited' ? Date.now() + this.settings.intervalSeconds * 2000 : 0);
          this.event(`Slot selection was not confirmed. ${this.lastError.message}`, 'error');
          this.event('Monitoring remains paused. Inspect the browser; no selection or payment request will be retried.', 'warning');
        }
        try { await this.browser.focus?.(); }
        catch { this.event('Could not bring RTD to the front. Switch to the app browser manually.', 'warning'); }
        this.event('The RTD browser stays open. No further automated actions will run until you continue.');
        this.event('Paused: next/n skips this week; restart/r restarts the full scan; quit/q closes the app browser.');
      }
      this.onResult(this.result, fresh.length);
    } catch (error) {
      if (error.code === 'scan_cancelled') {
        this.lastError = publicError(error);
        this.event(this.lastError.message, 'warning');
        return this.snapshot();
      }
      this.failures++;
      this.lastError = publicError(error);
      this.event(this.lastError.message, 'error');
      // A stale last result remains visibly stale. Structural/session errors
      // require intervention; transport errors get exponential backoff.
      if (this.lastError.code === 'rate_limited') {
        const backoff = Math.min(this.settings.intervalSeconds * 2 ** this.failures, 3600) * 1000;
        this.retryNotBefore = Math.max(Date.now() + backoff, this.lastError.retryAt || 0);
        this.event(this.running
          ? `Rate limited. Next attempt at ${new Date(this.retryNotBefore).toISOString()} (UTC); no requests during the wait.`
          : `Rate limited. Retry no earlier than ${new Date(this.retryNotBefore).toISOString()} (UTC).`, 'warning');
      } else if (!['request_failed', 'http_error'].includes(this.lastError.code) || this.failures >= 3) {
        this.running = false;
        this.event('Monitoring stopped. Check the RTD window before continuing.', 'warning');
      }
    } finally {
      this.busy = false;
      this.abortController = null;
      if (this.running) {
        const delay = Math.min(this.settings.intervalSeconds * 2 ** this.failures, 3600) * 1000;
        this.scheduleCheck(Math.max(Date.now() + delay, this.retryNotBefore));
      }
    }
    return this.snapshot();
  }

  async start() {
    this.assertIdle();
    if (this.running) return this.snapshot();
    this.assertCooldown();
    this.running = true;
    this.waitingForBooking = false;
    this.failures = 0;
    this.event('Monitoring started for the configured date range.');
    return this.check();
  }

  async continueAfterMatch() {
    this.assertIdle();
    this.assertCooldown();
    if (!this.waitingForBooking || !this.result?.matches.length) throw new AppError('not_paused', 'The monitor is not paused on matching slots.');
    this.busy = true;
    const controller = this.abortController = new AbortController();
    try {
      await this.browser.returnToCalendar?.(this.settings);
      if (controller.signal.aborted) throw new AppError('scan_cancelled', 'Return to calendar stopped.');
    } finally { this.busy = false; this.abortController = null; }
    const date = this.result.matches[0].date;
    const week = planWeeks(date, date)[0];
    this.skippedWeeks.add(week.from);
    // Rejected weeks no longer participate in alert state or future scans.
    this.previous = new Set([...this.previous].filter(key => {
      const slotDate = key.split('|')[2];
      return slotDate < week.from || slotDate > week.to;
    }));
    this.waitingForBooking = false;
    this.running = true;
    this.failures = 0;
    this.event(`Skipping ${week.from} - ${week.to} until restart. Continuing with later weeks.`);
    return this.check({ afterWeek: week.from });
  }

  async restart() {
    this.assertIdle();
    this.assertCooldown();
    this.event('Preparing to restart the full scan. Settings are unchanged.');
    await this.prepare();
    this.skippedWeeks.clear();
    this.failures = 0;
    this.event('Restarting the full scan. Previously skipped weeks are included again.');
    return this.start();
  }

  stop(log = true) {
    this.running = false;
    this.waitingForBooking = false;
    this.abortController?.abort();
    clearTimeout(this.timer);
    this.timer = null;
    this.nextCheck = null;
    if (log) this.event(this.busy ? 'Monitoring stopped. The in-flight request will finish.' : 'Monitoring stopped.');
    return this.snapshot();
  }
}
