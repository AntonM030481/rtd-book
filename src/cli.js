import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { publicConfig, launchConfig } from './config.js';
import { RtdBrowser } from './browser.js';
import { Monitor } from './monitor.js';
import { AppError, publicError } from './errors.js';

const help = `RTD Book - local console monitor

Usage:
  npm start                     use RTD_MODE from .env (default: once)
  npm start -- --mode once       check availability, print results and exit
  npm start -- --mode watch      scan, open the first match, stop for CAPTCHA/payment
  npm start -- --config          show configuration, without contacting RTD
  npm start -- --help            show help

--mode overrides RTD_MODE. Other settings are read from .env.

Credentials: RTD_USER, RTD_PASS, RTD_PLATE_NUMBER

Settings:
  RTD_MODE=once|watch
  RTD_CENTRE=1                   1 Nicosia, 2 Limassol, 3 Larnaca,
                                 4 Paphos, 7 Deryneia
  RTD_CATEGORY=BB                category as listed in RTD
  RTD_DATE_FROM=                 required inclusive start date (YYYY-MM-DD)
  RTD_DATE_TO=                   required inclusive end date (YYYY-MM-DD)
  RTD_TIME_FROM=07:00
  RTD_TIME_TO=18:00
  RTD_INTERVAL_SECONDS=120       pause after a full monitoring cycle
  RTD_SCAN_DELAY_SECONDS=2       pause between weeks (1-30 seconds)
  RTD_PAUSE_ON_MATCH=true        in watch mode, select the earliest matching slot
                                and stop at the CAPTCHA/payment page
  RTD_BROWSER_CHANNEL=chrome

Range scans cover the selected centre, at most 366 days per run.
An incomplete range is not reported as no availability.
No booking, payment, cancellation or rescheduling. All times are Cyprus time.
When watch mode pauses on a match: next/n skips that week; restart/r clears
skipped weeks and restarts the full scan with the same settings; quit/q or
Ctrl+C exits and closes the app browser. No startup menu or prompt.
On preparation or scan errors, the browser stays open for manual work.
Use restart/r to retry explicitly, or quit/q to close the browser and exit.
`;

export function commandOptions(args) {
  let values;
  try { ({ values } = parseArgs({ args, options: { mode: { type: 'string' }, help: { type: 'boolean' }, config: { type: 'boolean' } } })); }
  catch { throw new AppError('invalid_arguments', 'Invalid arguments. Use --mode once, --mode watch, --config or --help.'); }
  if (values.mode && !['once', 'watch'].includes(values.mode)) throw new AppError('invalid_arguments', '--mode must be once or watch.');
  return values;
}

const time = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Nicosia', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
const line = event => console.log(`[${time(event.at)}] ${event.level === 'error' ? 'ERROR: ' : event.level === 'warning' ? 'WARNING: ' : ''}${event.message}`);

function printResult(result, fresh) {
  console.log(`  Requested range: ${result.range.from} - ${result.range.to} | weeks checked: ${result.weeksChecked}/${result.plannedWeeks}${result.scanComplete ? '' : ' (stopped at matching week; remaining weeks not checked)'}`);
  console.log(`  Centre: ${result.centre} | category: ${result.category}`);
  if (result.afterWeek) console.log(`  This pass covers only weeks after ${result.afterWeek}.`);
  if (result.skippedWeeks?.length) console.log(`  Weeks excluded by you until restart: ${result.skippedWeeks.join(', ')}`);
  console.log(`  Available: ${result.available}; unavailable: ${result.unavailable}; unknown: ${result.unknown}`);
  if (result.matches.length) {
    console.log('  Date         Time    Status');
    for (const slot of result.matches) console.log(`  ${slot.date}   ${slot.time}   available according to RTD markup${slot.overtime ? ' (overtime, additional fee)' : ''}`);
    if (result.handoff?.status === 'ready') console.log('  CAPTCHA/payment page ready. Complete verification and payment yourself.');
    else if (result.handoff?.status === 'failed') console.log('  Automatic selection was not confirmed. Inspect the open RTD browser.');
    else console.log('  Open RTD to verify availability and book.');
    if (fresh) { console.log(`  New matching slots: ${fresh}`); if (process.stdout.isTTY) process.stdout.write('\x07'); }
  }
  if (result.warning) console.log(`  ${result.warning}`);
}

async function main() {
  let args, launch;
  try {
    args = commandOptions(process.argv.slice(2));
    if (args.help) { console.log(help); return; }
    launch = launchConfig({ ...process.env, ...(args.mode ? { RTD_MODE: args.mode } : {}) });
  } catch (error) { console.error(publicError(error).message); process.exitCode = 2; return; }
  if (args.config) {
    const flags = publicConfig();
    console.log(`.env: user ${flags.usernameConfigured ? 'set' : 'missing'}, password ${flags.passwordConfigured ? 'set' : 'missing'}, plate ${flags.plateConfigured ? 'set' : 'missing'}`);
    console.log(`Mode: ${launch.mode}; timezone: Asia/Nicosia`);
    console.table(launch.settings);
    return;
  }
  const browser = new RtdBrowser();
  const monitor = new Monitor(browser, launch.settings, { onEvent: line, onResult: printResult });
  let closing = false;
  let keeper;
  let commands;
  let controlBusy = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(keeper);
    monitor.stop(false);
    commands?.close();
    process.stdin.pause();
    await browser.close();
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  const finishOnce = async () => {
    await monitor.check();
    if (closing) return;
    process.exitCode = monitor.lastError || monitor.result?.status === 'partial' ? 1 : 0;
    if (monitor.lastError) enableCommands();
    else await close();
  };
  const enableCommands = () => {
    if (commands || closing) return;
    commands = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
    commands.on('SIGINT', () => { void close(); });
    commands.on('line', async text => {
      const command = text.trim().toLowerCase();
      if (command === 'q' || command === 'quit') { await close(); return; }
      if (['n', 'next', 'r', 'restart'].includes(command)) {
        if (controlBusy || monitor.busy) { console.log('Wait for the current operation, or use quit/q.'); return; }
        controlBusy = true;
        try {
          if (command === 'r' || command === 'restart') {
            if (launch.mode === 'watch') await monitor.restart();
            else { await monitor.prepare(); if (!closing) await finishOnce(); }
          } else if (launch.mode === 'watch') await monitor.continueAfterMatch();
          else console.log('Use restart/r to repeat the one-time scan, or quit/q to exit.');
        } catch (error) {
          if (!closing) console.error(publicError(error).message);
        } finally { controlBusy = false; }
      } else if (command) console.log('While paused: next/n (matching week), restart/r, quit/q.');
    });
    let reportedError = null;
    keeper = setInterval(() => {
      if (!closing && !controlBusy && !monitor.busy && !monitor.running && !monitor.waitingForBooking
        && monitor.lastError && reportedError !== monitor.lastError) {
        reportedError = monitor.lastError;
        console.log('Automation paused. The browser stays open for manual work. Use restart/r to retry, or quit/q to close and exit.');
      }
    }, 500);
  };
  if (launch.mode === 'watch') enableCommands();
  try {
    console.log(`Mode: ${launch.mode}; range: ${launch.settings.dateFrom} - ${launch.settings.dateTo}; centre: ${launch.settings.centre}`);
    await monitor.prepare();
    if (closing) return;
    if (launch.mode === 'once') {
      await finishOnce();
    } else {
      await monitor.start();
      if (closing) return;
      if (monitor.running) console.log('Monitoring. Press Ctrl+C to stop.');
    }
  } catch (error) {
    if (!closing) { if (monitor.lastError?.message !== publicError(error).message) console.error(publicError(error).message); process.exitCode = 1; }
    enableCommands();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
