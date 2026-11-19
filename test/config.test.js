import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { launchConfig } from '../src/config.js';
import { validateSettings, defaults } from '../src/settings.js';
import { commandOptions } from '../src/cli.js';
const dates = { RTD_DATE_FROM: '2026-12-04', RTD_DATE_TO: '2026-12-31' };
const validSettings = { ...defaults, dateFrom: dates.RTD_DATE_FROM, dateTo: dates.RTD_DATE_TO };

test('all launch settings are read from env', () => {
  const launch = launchConfig({ RTD_MODE: 'watch', RTD_CENTRE: '2', RTD_CATEGORY: 'BB', RTD_DATE_FROM: '2026-12-01', RTD_DATE_TO: '2026-12-31', RTD_TIME_FROM: '08:00', RTD_TIME_TO: '12:00', RTD_INTERVAL_SECONDS: '10' });
  assert.equal(launch.mode, 'watch');
  assert.deepEqual(launch.settings, { ...defaults, centre: '2', category: 'BB', intervalSeconds: 10, dateFrom: '2026-12-01', dateTo: '2026-12-31', timeFrom: '08:00', timeTo: '12:00' });
});
test('invalid modes, target dates and filters are rejected', () => {
  for (const env of [{ RTD_MODE: 'wrong' }, { RTD_DATE_FROM: '2026-02-31' }]) assert.throws(() => launchConfig({ ...dates, ...env }), { code: 'invalid_settings' });
  for (const change of [{ intervalSeconds: 9 }, { intervalSeconds: NaN }, { timeFrom: '25:00' }, { timeFrom: '15:00', timeTo: '12:00' }, { dateFrom: '2026-02-31' }, { dateFrom: '2026-12-12', dateTo: '2026-12-01' }, { centre: '999' }]) assert.throws(() => validateSettings({ ...validSettings, ...change }), { code: 'invalid_settings' });
});
test('config does not open browser or print supplied secrets', () => {
  const sentinels = ['SENTINEL_USER', 'SENTINEL_PASSWORD', 'SENTINEL_PLATE'];
  const output = execFileSync(process.execPath, ['src/cli.js', '--config'], { encoding: 'utf8', env: { ...process.env, ...dates, RTD_MODE: 'once', RTD_USER: sentinels[0], RTD_PASS: sentinels[1], RTD_PLATE_NUMBER: sentinels[2] } });
  for (const value of sentinels) assert.ok(!output.includes(value));
  assert.match(output, /user set, password set, plate set/);
});
test('mode argument overrides env; interactive mode and invalid modes are rejected', () => {
  assert.equal(commandOptions(['--mode', 'watch']).mode, 'watch');
  assert.equal(commandOptions(['--mode', 'once']).mode, 'once');
  assert.throws(() => commandOptions(['--mode', 'interactive']), { code: 'invalid_arguments' });
  assert.throws(() => commandOptions(['--password', 'secret']), { code: 'invalid_arguments' });
  assert.throws(() => launchConfig({ ...dates, RTD_MODE: 'interactive' }), { code: 'invalid_settings' });
  const output = execFileSync(process.execPath, ['src/cli.js', '--mode', 'once', '--config'], { encoding: 'utf8', env: { ...process.env, ...dates, RTD_MODE: 'watch' } });
  assert.match(output, /Mode: once/);
});
test('range scan requires bounds and validates pacing and size', () => {
  assert.throws(() => launchConfig({}), { code: 'invalid_settings' });
  assert.throws(() => launchConfig({ RTD_DATE_FROM: dates.RTD_DATE_FROM }), { code: 'invalid_settings' });
  assert.throws(() => launchConfig({ RTD_DATE_TO: dates.RTD_DATE_TO }), { code: 'invalid_settings' });
  assert.throws(() => launchConfig({ RTD_DATE_FROM: '2026-01-01', RTD_DATE_TO: '2027-12-31' }), { code: 'invalid_settings' });
  assert.throws(() => launchConfig({ ...dates, RTD_SCAN_DELAY_SECONDS: '0' }), { code: 'invalid_settings' });
  assert.throws(() => launchConfig({ ...dates, RTD_PAUSE_ON_MATCH: 'yes' }), { code: 'invalid_settings' });
  assert.equal(launchConfig({ ...dates, RTD_PAUSE_ON_MATCH: 'false' }).settings.pauseOnMatch, false);
  const config = launchConfig({ ...dates, RTD_SCAN_DELAY_SECONDS: '3' });
  assert.equal(config.settings.scanDelaySeconds, 3);
});
test('help is available without launching RTD', () => {
  const output = execFileSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8' });
  assert.match(output, /local console monitor/); assert.match(output, /RTD_MODE/);
});
test('application sources contain no Russian messages', async () => {
  for (const file of await readdir('src')) if (file.endsWith('.js')) assert.doesNotMatch(await readFile(`src/${file}`, 'utf8'), /[А-Яа-яЁё]/, file);
});
