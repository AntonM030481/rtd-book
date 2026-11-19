import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, publicError } from './errors.js';
import { filterSlots } from './parser.js';

const dayMs = 86400000;
const iso = stamp => new Date(stamp).toISOString().slice(0, 10);

export function planWeeks(from, to) {
  const end = Date.parse(to);
  let cursor = Date.parse(from);
  if (!Number.isFinite(cursor) || !Number.isFinite(end) || cursor > end || end - cursor > 365 * dayMs) {
    throw new AppError('invalid_settings', 'Provide an ordered date range of at most 366 days.');
  }
  const weeks = [];
  while (cursor <= end) {
    const weekday = new Date(cursor).getUTCDay();
    if (weekday === 0) { cursor += dayMs; continue; }
    const monday = cursor - (weekday - 1) * dayMs;
    // Select Saturday to avoid selecting a date before an account's earliest
    // eligible day in the first week. Only in-range slots enter the results.
    weeks.push({ from: iso(monday), to: iso(monday + 5 * dayMs), target: iso(monday + 5 * dayMs) });
    cursor = monday + 7 * dayMs;
  }
  if (!weeks.length) throw new AppError('invalid_settings', 'The range contains only Sunday; RTD displays Monday through Saturday.');
  return weeks;
}

export async function scanRange(browser, settings, { signal, onProgress = () => {}, delay = sleep, pauseOnMatch = false, skippedWeeks = new Set(), afterWeek = null } = {}) {
  const allWeeks = planWeeks(settings.dateFrom, settings.dateTo);
  const weeks = allWeeks.filter(week => !skippedWeeks.has(week.from) && (!afterWeek || week.from > afterWeek));
  const cancelled = () => { if (signal?.aborted) throw new AppError('scan_cancelled', 'Scan stopped. The incomplete range is not a current availability result.'); };
  const slots = [];
  const dates = [];
  let weeksChecked = 0;
  let pausedOnMatch = false;
  for (const [index, week] of weeks.entries()) {
    cancelled();
    onProgress(`Scanning week ${index + 1}/${weeks.length}: ${week.from} - ${week.to}.`);
    try {
      await browser.selectDate(week.target);
      cancelled();
      const calendar = await browser.check(settings);
      cancelled();
      // Revalidate coverage independently of the page's selected date. A stale
      // response from another week must not count toward a complete range.
      if (calendar.dates[0] !== week.from || calendar.dates.at(-1) !== week.to || calendar.dates.length !== 6) {
        throw new AppError('week_mismatch', 'RTD returned a different or incomplete week.');
      }
      if (calendar.centre !== settings.centre || calendar.category !== settings.category) throw new AppError('context_mismatch', 'The returned exam context changed during the scan.');
      slots.push(...calendar.slots.filter(slot => slot.date >= settings.dateFrom && slot.date <= settings.dateTo));
      dates.push(...calendar.dates.filter(date => date >= settings.dateFrom && date <= settings.dateTo));
      weeksChecked++;
      if (pauseOnMatch && filterSlots(calendar.slots, settings).length) {
        pausedOnMatch = true;
        break;
      }
    } catch (error) {
      cancelled();
      if (error.code === 'scan_cancelled') throw error;
      const safe = publicError(error);
      throw new AppError(safe.code, `Range incomplete (${index}/${weeks.length} weeks checked). ${safe.message}`, safe);
    }
    if (index < weeks.length - 1) {
      try { await delay(settings.scanDelaySeconds * 1000, undefined, { signal }); }
      catch (error) { if (signal?.aborted) cancelled(); throw error; }
    }
  }
  const keys = slots.map(slot => `${slot.date}|${slot.time}`);
  if (new Set(keys).size !== keys.length) throw new AppError('unexpected_response', 'Duplicate slots across scanned weeks. The range is incomplete.');
  const unknown = slots.filter(slot => slot.availability === 'unknown').length;
  return { status: unknown ? 'partial' : 'ok', centre: settings.centre, category: settings.category,
    range: { from: settings.dateFrom, to: settings.dateTo }, weeksChecked,
    plannedWeeks: weeks.length, scanComplete: weeksChecked === weeks.length, pausedOnMatch,
    skippedWeeks: allWeeks.filter(week => skippedWeeks.has(week.from)).map(week => week.from),
    afterWeek,
    dates: [...new Set(dates)].sort(), slots,
    available: slots.filter(slot => slot.availability === 'available').length,
    unavailable: slots.filter(slot => slot.availability === 'unavailable').length, unknown,
    warning: unknown ? 'Some cells use unverified markup. Their availability is unknown.' : null };
}
