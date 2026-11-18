import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { defaults, validateSettings } from './settings.js';
import { AppError } from './errors.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);

export const config = {
  username: process.env.RTD_USER || '',
  password: process.env.RTD_PASS || '',
  plate: process.env.RTD_PLATE_NUMBER || '',
  browserChannel: process.env.RTD_BROWSER_CHANNEL || 'chrome',
};

export function publicConfig() {
  return {
    usernameConfigured: Boolean(config.username),
    passwordConfigured: Boolean(config.password),
    plateConfigured: Boolean(config.plate),
  };
}

export function launchConfig(env = process.env) {
  const mode = env.RTD_MODE || 'once';
  if (!['once', 'watch'].includes(mode)) throw new AppError('invalid_settings', 'RTD_MODE must be once or watch.');
  const settings = validateSettings({
    centre: env.RTD_CENTRE || defaults.centre, category: env.RTD_CATEGORY || defaults.category,
    intervalSeconds: Number(env.RTD_INTERVAL_SECONDS || defaults.intervalSeconds),
    dateFrom: env.RTD_DATE_FROM || '', dateTo: env.RTD_DATE_TO || '',
    timeFrom: env.RTD_TIME_FROM || defaults.timeFrom, timeTo: env.RTD_TIME_TO || defaults.timeTo,
    scanDelaySeconds: Number(env.RTD_SCAN_DELAY_SECONDS || defaults.scanDelaySeconds),
    pauseOnMatch: env.RTD_PAUSE_ON_MATCH === undefined || env.RTD_PAUSE_ON_MATCH === '' ? true
      : env.RTD_PAUSE_ON_MATCH === 'true' ? true : env.RTD_PAUSE_ON_MATCH === 'false' ? false : null,
  });
  return { mode, settings };
}
