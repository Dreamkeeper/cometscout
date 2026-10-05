# 15: Digest days, digest time, and interview prep before new applications

## Why
The evening run offers up to two roles a day to apply to, every day. Two things make that wrong for real users:
- Many people do not want job-search messages on some days (weekends, a regular busy day). The days, and the time, should be theirs to choose, from wherever they use CometScout: the web workspace and Telegram.
- In the days before an interview, the best use of the user's one daily slot is usually preparing for that interview, not applying to new roles. A role should still interrupt prep when it is both strong and urgent, but an average find can wait a few days.

Maintainer decisions (2026-10-05):
- Digest days and the digest time are user settings, editable in the web workspace and in the Telegram bot.
- Off days still run sources and decode, so nothing piles up; they send nothing and show no picks. The first digest after off days says what came in meanwhile.
- Prep mode covers the evening digests in the 2 days before an interview. On the interview day it applies only when the digest runs before the interview time.
- In prep mode: at most 1 pick, and only a strong fit with apply priority 1 decoded in the last 2 days. The other roles wait, and waiting does not use up their showings.

Read `DEVELOPMENT.md` first. Plain Node 20, no new dependencies, synthetic data only, no em dashes in user-facing text, English and Russian labels. Every change gets a test; `npm test` must pass on Linux and Windows.

## 1. Settings
- `schedule: { "days": [1, 2, 3, 4, 5, 6, 7], "time": "18:00" }`, ISO weekdays (Monday = 1), in `settings.timezone`. An existing `run_time` is read as `schedule.time` (keep accepting it; `doctor` suggests the new key). Validate: days are unique integers 1-7, at least one; time is HH:MM.
- `picks.prep: { "days_before": 2, "max": 1, "verdicts": ["strong-fit"], "max_priority": 1, "fresh_days": 2 }`. `days_before: 0` turns prep mode off.
- The daily timer still runs every day at `schedule.time`; the day check is in the run, so changing days never needs a timer change. Changing the time reinstalls the timer (the existing `cli.mjs timer` path).

## 2. The evening run
- **Off day** (today, in the user's timezone, not in `schedule.days`): sources and decode run as usual. No Telegram digest, no picks shown, nothing counted as shown. The digest is still written to `data/digests/` with a first line saying it was an off day and not sent.
- **First digest after off days:** one line at the top: which days were held back (only days whose digest really was held back), how many roles were decoded, how many are worth applying to, and that they are in the picks pool.
- **Prep mode:** the next interview is 1 to `days_before` days ahead, or later today (an interview with no time counts as later today). The digest then opens with the interview (company, round, day, time, "today"/"tomorrow"/"in N days") and the day's prep step: 2 or more days out, prep and likely concerns; 1 day out, practice or a mock on the predicted questions; interview day, a short confidence plan and a warm-up answer. When the coach module is enabled, name the coach command for the step. Then either the one pick that qualifies, or "N roles wait until after the interview". Today's new worth-applying decodes are listed one line each under "for after the interview", without the apply instructions.
- Picks that wait are not marked as shown.

## 3. Where interview dates come from
- An application event of type `interview` with an `event_date` today or later. Add an optional `event_time` (HH:MM, user's timezone) to the event, and to the outcomes classifier schema (an email that books a slot usually states the time; empty when it does not).
- A way to record a booked interview by hand: `node cli.mjs interview <company> <YYYY-MM-DD> [HH:MM] [role words] [--round "..."]` writes an `interview` event with the date and time (and sets the status to `interview` unless it is already further). The same action in the workspace job pane.
- The coach hand-off "Coming up" shows the time when known.

## 4. Web workspace
A settings view (or panel) with: the seven days as toggles, the time, and the prep window (days before, 0 = off). Saving writes `settings.json` through an API endpoint that validates like `doctor`, keeps unknown keys and formatting stable, and reinstalls the timer when the time changed (on systemd hosts; elsewhere it says which command to run). The Today screen shows prep mode the same way the digest does.

## 5. Telegram bot
The bot only sends today. Add a minimal command handler, the first piece of the M5 bot: `node cli.mjs bot` long-polls `getUpdates` (a systemd user unit next to the timer, installed by `cli.mjs timer` when Telegram delivery is on), answers only the configured chat id, and ignores everyone else silently.
- `/schedule`: shows days, time and prep window, with inline buttons to toggle each day and to set prep days (0, 1, 2, 3).
- `/time HH:MM`: sets the time (reinstalls the timer).
- `/interview <company> <YYYY-MM-DD> [HH:MM]`: the same as the CLI command.
- `/help`: lists the commands.
Changes go through the same settings writer as the workspace. Keep the handler small and structured so later bot commands (picks, applied, skip) can be added.

## Tests
- Off day: run with a fixed date on a day not in `schedule.days`: no Telegram call, picks state unchanged, the digest file has the off-day line. The next digest day shows the held-back summary; a day whose digest was sent is not counted.
- Prep mode: interview tomorrow → 1 qualifying pick at most, a non-qualifying pool → "wait" line and no pick, showings unchanged; interview today before the run time → prep; after it → normal; `days_before: 0` → normal.
- `interview` CLI command and API write the event with date and time; the classifier result with `event_time` is stored.
- Settings writer: validation, unknown keys kept, timer reinstall only on a time change.
- Bot: a fake Telegram transport; commands from another chat id are ignored; `/schedule` button toggles change `settings.json`.
- Russian labels exist for every new string.

## Done when
`npm test` passes on Linux and Windows; README, INSTALL.md, README-rus.md and the Russian install guide describe the schedule, prep mode and the bot commands; ROADMAP updated. PR description lists what was built, what was not, and open questions.
