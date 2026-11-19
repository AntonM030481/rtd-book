# RTD Book

A local **console application** for monitoring Cyprus RTD driving test availability. No web dashboard or HTTP server. An isolated Chrome profile supplies the authenticated RTD session.

## Start

Requires Node.js 22.16+ and installed Google Chrome.

```powershell
npm install
# Only if .env does not already exist:
Copy-Item .env.example .env
npm start
```

Two modes, without a startup menu or interactive setup:

```powershell
npm start -- --mode once   # check availability and exit
npm start -- --mode watch  # monitor; pause on a matching week for manual booking
```

`--mode` overrides `RTD_MODE` from `.env`. Without it, `npm start` uses `.env` (default `once`). All other runtime settings remain in `.env`.

All credentials and runtime parameters belong in `.env`. See [.env.example](.env.example). Restart after editing it. Quote values containing `#` or spaces. Never pass passwords on the command line.

| Variable | Purpose / default |
|---|---|
| `RTD_USER`, `RTD_PASS` | RTD login and password |
| `RTD_PLATE_NUMBER` | Vehicle registration |
| `RTD_MODE` | `once` (default) or `watch`; overridden by `--mode` |
| `RTD_CENTRE` | `1` Nicosia, `2` Limassol, `3` Larnaca, `4` Paphos, `7` Deryneia |
| `RTD_CATEGORY` | Category as shown in RTD; Latin `BB` also matches Greek `ΒΒ` |
| `RTD_DATE_FROM`, `RTD_DATE_TO` | Required inclusive date bounds; every intersecting week is scanned |
| `RTD_TIME_FROM`, `RTD_TIME_TO` | Inclusive time filters; `07:00`, `18:00` |
| `RTD_INTERVAL_SECONDS` | Pause after a complete monitoring cycle, 60–3600; default `120` |
| `RTD_SCAN_DELAY_SECONDS` | Pause between weeks, 1–30 seconds; default `2` |
| `RTD_PAUSE_ON_MATCH` | Default `true`: pause watch mode at a matching week and keep the browser open |
| `RTD_BROWSER_CHANNEL` | Installed browser channel; default `chrome` |

`.env` and `.local/browser` are ignored by Git. Credential values, cookies and raw HTML are never printed or saved in logs. Browser cookies remain in the local profile. `npm start -- --config` shows settings and whether credentials are present, without contacting RTD. `npm start -- --help` prints help. Availability is checked by `--mode once`, not by `--config`.

## Scan a date range

```dotenv
RTD_MODE=once
RTD_CENTRE=1
RTD_DATE_FROM=2026-12-04
RTD_DATE_TO=2026-12-31
RTD_PAUSE_ON_MATCH=true
```

The app opens a separate Chrome window, makes at most one login attempt, fills the exam centre, category and vehicle, and checks each week in order. The date range is bounded explicitly: there is no unbounded "all future dates" operation. Ranges can contain up to 366 days. Extend the bounds to include more months. The scan covers the configured centre, not every city.

Navigation selects a Saturday to load each Monday–Saturday week, including weeks crossing month/year boundaries. Only slots inside the requested bounds are returned. This may navigate to a day just outside the range to load its last week. The app waits for actual frame navigation and verifies the returned week, rather than trusting a date field that updates before the table.

Availability is read directly from that loaded document. There is no second `fetch` or background calendar POST: each scanned week needs one calendar navigation, and the displayed table is the one being checked. A matching week stays visible without an extra refresh or login. Other page resources and initial login/setup may still make requests.

## Manual booking during monitoring

With `RTD_PAUSE_ON_MATCH=true`, `watch` stops at the **first week with slots matching the configured dates and times**. It prints the slots, brings the RTD browser to the front and leaves it open on that week. It makes no further availability requests or calendar changes while paused. You complete booking and payment yourself. A partial scan is labelled with the number of weeks actually checked.

While paused, enter a command in the same terminal and press Enter:

| Command | Action |
|---|---|
| `next` / `n` | Reject this week and continue with later weeks. The rejected week is excluded from later cycles until restart. |
| `restart` / `r` | Clear rejected weeks, prepare the calendar and scan the entire configured range again using the same settings. |
| `quit` / `q` | Stop the app and close its browser. Ctrl+C does the same. |

Commands do not book or cancel anything. `restart` does not reread `.env`; exit and launch again to apply edited settings. Do not exit while still using the app browser to finish a booking. If a slot has disappeared since detection, continue searching with `next` or `restart`.

Set `RTD_PAUSE_ON_MATCH=false` to keep scanning and only print results. `once` always completes the requested range, even when matches exist; it then closes the browser and exits. In `once` mode, exit code `0` means a complete recognized response (including no slots), `1` means failure/partial data, and `2` means invalid configuration.

## HTTP limits and access errors

HTTP `429` means rate limiting. HTTP `403` means access was refused; it does not by itself prove a permanent account ban. HTTP `401` means authentication is required. The app observes existing RTD document responses during preparation and scanning; it sends no extra requests to diagnose errors.

During a watch scan, `429` pauses all scanning and keeps the browser open. The retry delay doubles from `RTD_INTERVAL_SECONDS`: with 120 seconds configured, consecutive limits wait 240, 480, 960, 1920, then 3600 seconds. Local backoff is capped at one hour. A valid `Retry-After` (seconds or HTTP date) sets a minimum deadline and is never shortened by that cap. There is no fixed 15-minute minimum. The console prints the next attempt time in UTC; `restart` cannot bypass the wait, and `quit` cancels it. After a successful scan pass, the normal configured interval resumes. Previous availability remains stale during errors, not a new zero-slot result.

When the wait expires, the app resubmits only the rejected calendar POST, using its original fields and the same browser frame/session, then resumes range scanning. The request is retained only in memory. Login, booking and payment requests are never replayed. If the frame changed, recovery is unavailable, the session expired, or the page is unfamiliar, monitoring stops. `429` during initial login/preparation also stops: startup is not retried automatically. `once` always reports the error and exits without scheduling retries. A new process does not persist the previous waiting deadline.

HTTP `403` and `401` still stop the run and close the app browser; they do not trigger backoff or repeated login attempts. Check access manually before restarting. Unknown HTML, including a denial page returned as HTTP `200`, stops through calendar validation rather than being treated as no availability. Rate-limit recovery, increasing delays and server deadlines were verified with intercepted browser responses and fake time, not by provoking limits on RTD. Real RTD recovery after a `429` remains unverified.

## Current scope

- The example `.env` scans December 4–31 in one centre. Every run uses the required date range; calendar navigation supports dates within 24 months of the displayed month.
- Sequential calendar navigation uses the site's current form and browser cookies, with a 20-second navigation timeout. The app validates the HTTP response and reads the displayed DOM, verifying centre, category, selected date and returned week.
- `redtime.gif` was observed on the live site. `greentime.gif` is supported based on the proposed naming hypothesis and still needs validation against a live free slot. Other backgrounds, including unverified overtime markup, are **unknown**, not occupied.
- A failed week aborts the range and preserves the previous successful result as stale. It is not a complete "no slots" result. Login/form/week errors stop monitoring. Retryable transport/server errors use exponential backoff; three consecutive non-429 failures stop it. Calendar `429` responses use the recovery policy above; other error pages are not automatically restored.
- Unknown intermediate forms or authentication challenges stop automatic startup with an error. There is no interactive setup menu. Manual booking is supported only after successful calendar preparation and slot detection.
- This is not a public RTD API contract. Unknown page structure requires manual inspection. Results are informational; verify availability and complete booking in RTD.

## Development checks

```powershell
npm test
npm run check
```

Tests use synthetic calendar fixtures, a fake transport and installed Chrome in headless mode with all requests intercepted: date/time mapping, login and malformed responses, unknown cells, stale weeks, range coverage, cancellation, backoff, deduplication, env/argument precedence, credential redaction, pause-on-match, skip, restart, browser retention, displayed-calendar reading without additional requests, and HTTP access/rate-limit handling. They make no real RTD requests.

Live smoke tests on 2026-11-17: credentials loaded from `.env`, login and calendar preparation succeeded. The initial week returned 72 unavailable cells. A subsequent automatic range scan covered **all five weeks intersecting 2026-12-01 through 2026-12-31 in Nicosia / BB**, including navigation into January; it returned **324 in-range unavailable cells, zero green cells and zero unknown cells**, and exited successfully. RTD sends uppercase HTML attributes; the parser normalizes their names to reproduce browser parsing. Live free-slot markup and the payment flow remain unverified. Pause/skip/restart were tested using synthetic matches. No booking, payment or cancellation was performed.

Earlier research notes (Russian): [booking analysis](docs/rtd-booking-analysis.md), [official sources](docs/rtd-official-sources.md).

After removing the extra fetch, a live scan of the configured range completed all five weeks with exactly five calendar POSTs: 288 in-range unavailable cells, zero available and zero unknown. The browser was closed afterward. Free-slot interaction remains unverified live.
