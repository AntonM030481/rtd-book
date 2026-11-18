import { parseHTML } from 'linkedom';
import { AppError } from './errors.js';

function fail(message) { throw new AppError('unexpected_response', message); }

export function isoDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/.exec(value);
  if (!match) return null;
  const [, day, month, year] = match;
  const fullYear = year.length === 2 ? `20${year}` : year;
  const iso = `${fullYear}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

export function parseCalendar(html, { expectedDate, status = 200 } = {}) {
  if (status < 200 || status >= 300) throw new AppError('http_error', `RTD returned HTTP ${status}. Availability was not checked.`);
  const { document } = parseHTML(html);
  // RTD's legacy HTML uses uppercase attributes (e.g. BACKGROUND). LinkeDOM
  // preserves their case, unlike a browser HTML parser. Normalize names only;
  // form values and category codes must remain untouched.
  for (const element of document.querySelectorAll('*')) {
    for (const name of element.getAttributeNames()) {
      const lower = name.toLowerCase();
      if (lower !== name) {
        const value = element.getAttribute(name);
        element.removeAttribute(name);
        if (!element.hasAttribute(lower)) element.setAttribute(lower, value);
      }
    }
  }
  if (document.querySelector('input[type="password"]')) {
    throw new AppError('session_expired', 'RTD requires login. Restore the session in the browser.');
  }
  const form = document.querySelector('form[name="vrmSearch"]');
  if (!form) fail('No calendar form in the response. Availability is unknown.');

  // Only rows containing direct slot cells count; nested layout tables must not
  // duplicate headers or assign times to the wrong date.
  const rows = [...document.querySelectorAll('tr')];
  let dates = null;
  const slots = [];
  for (const row of rows) {
    const cells = [...row.children].filter(el => /^(TD|TH)$/.test(el.tagName));
    const rowDates = cells.map(cell => {
      if (cell.querySelector('table')) return null;
      const match = cell.textContent.trim().match(/(\d{2}\/\d{2}\/\d{2}(?:\d{2})?)\s*$/);
      return match ? isoDate(match[1]) : null;
    }).filter(Boolean);
    if (rowDates.length >= 5) {
      if (dates) fail('Multiple weekly tables found. The markup needs inspection.');
      dates = rowDates;
      if (dates.length > 7 || new Set(dates).size !== dates.length || dates.some((d, i) => i > 0 && Date.parse(d) - Date.parse(dates[i - 1]) !== 86400000)) {
        fail('Calendar headers do not form a consecutive date range.');
      }
      continue;
    }
    const timeCells = cells.filter(cell => cell.hasAttribute('background') && !cell.querySelector('table') && /^\d{1,2}:\d{2}$/.test(cell.textContent.trim()));
    if (!timeCells.length) continue;
    if (!dates || timeCells.length !== dates.length) fail('Could not map time cells to weekday headers.');
    for (const [index, cell] of timeCells.entries()) {
      const time = cell.textContent.trim().padStart(5, '0');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail('An invalid time was found in the calendar.');
      const background = cell.getAttribute('background').split('/').pop().toLowerCase();
      const availability = background === 'redtime.gif' ? 'unavailable'
        : background === 'greentime.gif' ? 'available' : 'unknown';
      // Blue/overtime markup has not been verified live. Never infer a bookable
      // slot merely because it is not red, or trust a link without its semantics.
      slots.push({ date: dates[index], time, availability, background,
        hasAction: Boolean(cell.querySelector('a, input, button') || cell.hasAttribute('onclick')) });
    }
  }
  if (!dates || !slots.length) fail('The weekly calendar was not recognized. Availability is unknown.');
  const keys = slots.map(slot => `${slot.date}|${slot.time}`);
  if (new Set(keys).size !== keys.length) fail('Duplicate calendar slots were found.');
  if (expectedDate && !dates.includes(expectedDate)) {
    throw new AppError('week_mismatch', 'RTD returned a different week. Wait for the selected week in the browser.');
  }
  const unknown = slots.filter(slot => slot.availability === 'unknown').length;
  return { status: unknown ? 'partial' : 'ok', dates, slots,
    available: slots.filter(slot => slot.availability === 'available').length,
    unavailable: slots.filter(slot => slot.availability === 'unavailable').length,
    unknown,
    warning: unknown ? 'Some cells use unverified markup. Their availability is unknown.' : null };
}

export function filterSlots(slots, filters) {
  return slots.filter(slot => slot.availability === 'available'
    && (!filters.dateFrom || slot.date >= filters.dateFrom)
    && (!filters.dateTo || slot.date <= filters.dateTo)
    && slot.time >= filters.timeFrom && slot.time <= filters.timeTo);
}
