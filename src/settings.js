import { AppError } from './errors.js';

export const defaults = Object.freeze({
  centre: '1', category: 'ΒΒ', intervalSeconds: 120,
  dateFrom: '', dateTo: '', timeFrom: '07:00', timeTo: '18:00',
  scanDelaySeconds: 2,
  pauseOnMatch: true,
});

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('invalid_settings', 'Invalid settings.');
  const value = { ...defaults };
  for (const key of Object.keys(defaults)) if (Object.hasOwn(input, key)) value[key] = input[key];
  const bad = message => { throw new AppError('invalid_settings', message); };
  if (!['1', '2', '3', '4', '7'].includes(value.centre)) bad('Select a valid exam centre.');
  if (typeof value.category !== 'string' || !value.category.trim() || value.category.length > 20) bad('Enter the licence category as shown in RTD.');
  value.category = value.category.trim();
  if (!Number.isInteger(value.intervalSeconds) || value.intervalSeconds < 10 || value.intervalSeconds > 3600) bad('The check interval must be between 10 and 3600 seconds.');
  for (const key of ['dateFrom', 'dateTo']) {
    if (typeof value[key] !== 'string') bad('Invalid date.');
    if (value[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(value[key]) || !Number.isFinite(Date.parse(value[key])) || new Date(value[key]).toISOString().slice(0, 10) !== value[key])) bad('Invalid date.');
  }
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) bad('The start date must not be later than the end date.');
  if (typeof value.pauseOnMatch !== 'boolean') bad('RTD_PAUSE_ON_MATCH must be true or false.');
  if (!Number.isFinite(value.scanDelaySeconds) || value.scanDelaySeconds < 1 || value.scanDelaySeconds > 30) bad('RTD_SCAN_DELAY_SECONDS must be between 1 and 30.');
  if (!value.dateFrom || !value.dateTo) bad('RTD_DATE_FROM and RTD_DATE_TO are required.');
  if (Date.parse(value.dateTo) - Date.parse(value.dateFrom) > 365 * 86400000) bad('A scan range may contain at most 366 days. Split longer periods into separate runs.');
  for (const key of ['timeFrom', 'timeTo']) if (typeof value[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value[key])) bad('Invalid time.');
  if (value.timeFrom > value.timeTo) bad('The start time must not be later than the end time.');
  return value;
}
