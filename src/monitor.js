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
    this.stop(false);
    this.busy = true;
    try {
      const outcome = await this.browser.prepare(this.settings);
      this.result = null;
      this.previous.clear();
      this.lastError = null;
      this.event(outcome.message);
      return outcome;
    } catch (error) {
      this.lastError = publicError(error);
      this.event(this.lastError.message, 'error');
      throw error;
    } finally { this.busy = false; }
  }

  async check({ afterWeek = null } = {}) {
    this.assertIdle();
    clearTimeout(this.timer);
    this.nextCheck = null;
    this.busy = true;
    this.lastAttempt = new Date().toISOString();
    this.abortController = new AbortController();
    try {
      const calendar = await scanRange(this.browser, this.settings, { signal: this.abortController.signal, onProgress: message => this.event(message), pauseOnMatch: this.running && this.settings.pauseOnMatch, skippedWeeks: this.skippedWeeks, afterWeek });
      const matches = filterSlots(calendar.slots, this.settings);
      const keys = new Set(matches.map(slot => `${calendar.centre}|${calendar.category}|${slot.date}|${slot.time}`));
      const fresh = [...keys].filter(key => !this.previous.has(key));
      if (fresh.length) this.notificationSeq++;
      this.previous = calendar.scanComplete === false || afterWeek ? new Set([...this.previous, ...keys]) : keys;
      this.result = { ...calendar, matches, checkedAt: new Date().toISOString() };
      this.lastError = null;
      this.failures = 0;
      const pause = this.running && this.settings.pauseOnMatch && matches.length > 0;
      if (pause) { this.running = false; this.waitingForBooking = true; }
      this.event(pause
        ? `Matching slots found: ${matches.length}. Monitoring is paused for manual booking.`
        : calendar.status === 'partial'
        ? `Partial result: ${calendar.unknown} unknown cells.`
        : `${afterWeek ? 'Remaining weeks' : 'Range'} checked. Matching slots: ${matches.length}.`, calendar.status === 'partial' ? 'warning' : 'info');
      this.onResult(this.result, fresh.length);
      if (pause) {
        try { await this.browser.focus?.(); }
        catch { this.event('Could not bring RTD to the front. Switch to the app browser manually.', 'warning'); }
        this.event('The RTD browser stays on this week for manual booking. No further scans will run until you continue.');
        this.event('Paused: next/n skips this week; restart/r restarts the full scan; quit/q closes the app browser.');
      }
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
      if (!['request_failed', 'http_error'].includes(this.lastError.code) || this.failures >= 3) {
        this.running = false;
        this.event('Monitoring stopped. Check the RTD window before continuing.', 'warning');
      }
    } finally {
      this.busy = false;
      this.abortController = null;
      if (this.running) {
        const delay = Math.min(this.settings.intervalSeconds * 2 ** this.failures, 3600) * 1000;
        this.nextCheck = new Date(Date.now() + delay).toISOString();
        this.timer = setTimeout(() => { void this.check(); }, delay);
        this.timer.unref?.();
      }
    }
    return this.snapshot();
  }

  async start() {
    this.assertIdle();
    if (this.running) return this.snapshot();
    this.running = true;
    this.waitingForBooking = false;
    this.failures = 0;
    this.event('Monitoring started for the configured date range.');
    return this.check();
  }

  async continueAfterMatch() {
    this.assertIdle();
    if (!this.waitingForBooking || !this.result?.matches.length) throw new AppError('not_paused', 'The monitor is not paused on matching slots.');
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
    this.stop(false);
    this.skippedWeeks.clear();
    this.previous.clear();
    this.result = null;
    this.lastError = null;
    this.failures = 0;
    this.event('Restarting the full scan. Previously skipped weeks are included again. Settings are unchanged.');
    await this.prepare();
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
