# Changelog

Generated from `release.json` by `node tools/changelog.mjs`. Edit `release.json`, not this file.

## 0.2.2 (2026-10-24)

Needs Node 22 or newer. This version changes behaviour: read Changed before updating.

### Highlights

- A smoother first setup: the onboarding agent asks one question at a time, shows every change before it writes it, and picks up where a broken-off session stopped.
- Installing or changing the timer never starts a run by itself; it says when the next one is.

### New

- Job boards on Personio and Gem, next to Greenhouse, Ashby and Lever.
- node cli.mjs onboarding-state: the setup steps, done or not, and the next one.
- node cli.mjs settings set <key> <json-value> [--dry-run]: change one setting, checked like doctor, with the diff.
- node cli.mjs install-module coach|transcribe, node cli.mjs sources --only <name>, node cli.mjs lint and node cli.mjs update --refresh-home: the installers, a single source, the lint check and the home's docs, always from the installed release.

### Changed

- candidate_name is null by default: your name comes from profile/profile.md. doctor says when settings.json still has the example person's name, or data/ holds decodes made with the example profile.
- node cli.mjs reset --yes keeps data/state/schema.json, update.json and runs.jsonl, which describe the install.
- Every update, adopt and rollback refreshes AGENTS.md, the READMEs, INSTALL.md and the example files in the home, and the scripts they name become wrappers for the installed release's copies. An edited copy is saved to app/replaced/ first.
- doctor finds Claude Code in ~/.local/bin when the shell's PATH lacks it.
- The timer is persistent only once an evening run has happened, and every install resets its stamp, so no install starts a catch-up run.
- A salary expectation in the form answers is left blank, with your floor and the posting's range as a note: the floor is a minimum, not the figure to ask for.
- The drop folder defaults to ~/cometscout-drop and is created on the first run.

### Action needed

- After updating from 0.2.1, run node cli.mjs update --refresh-home once: 0.2.1's updater does not refresh the home's docs, so AGENTS.md there is still the old one (doctor says so).

## 0.2.1 (2026-10-15)

Needs Node 22 or newer. This version changes behaviour: read Changed before updating.

### Highlights

- The RealtimeJobs source keeps working through RTJ's rename of its API fields on 17 October 2026: update before then if you use it.
- Cleaner transcripts of real recordings: the glossary no longer replaces ordinary words, fewer phantom speakers, and speech after a long pause is no longer lost.
- A new install uses the machine's own time zone, so the digest arrives at the hour you expect.

### Changed

- RealtimeJobs: requests use snake_case field names and fall back to the old camelCase once when the API asks for it, so the source works before and after RTJ's rename on 17 October 2026; the next-page cursor is read in both styles; the page size is capped at 250, the API maximum; a job RTJ already sent is recognised by its stable id even after its title or URL changed.
- Glossary: terms taken from your own data are names only (brands, products, Latin-script words), never a common word, a part of a hyphenated word or a Russian case form of a name. Terms you wrote into profile/glossary.txt work as before.
- Merge: an English-looking near miss from Whisper becomes the glossary term; a glossary term settles a Cyrillic disagreement only when Whisper is sure of its word; no word mixes Latin and Cyrillic letters, and no word is doubled where the engines meet.
- Speakers: a speaker with under 60 seconds and under 3% of the speech is merged into the nearest voice, and the transcript header says so.
- GigaAM never joins speech across a pause longer than 3 seconds (speech after a long pause was being lost), and the header warns about a long stretch with sound but no text.
- Whisper reads long recordings in 10-minute pieces cut between words: an hour now peaks at about 1.9 GB of memory instead of 4.2 GB.
- The transcript header times every stage, speaker separation included, with the total and the peak memory; "downloads" is said only when a model really downloads.
- The digest lists the jobs worth applying in the same order as the picks of the day.
- A new settings.json gets this machine's time zone instead of the example's; an existing one is never changed.
- The install guides name Claude Code 2.1.292 and Codex 0.161.0, and the transcription default (large-v3-turbo, about 1.6 GB) correctly.

### Action needed

- If a product or standard name that is also a common English word (for example Matter) should be fixed in transcripts, add it to profile/glossary.txt: the automatic glossary no longer takes common words.

## 0.2.0 (2026-10-14)

Needs Node 22 or newer. This version changes behaviour: read Changed before updating.

### Highlights

- CometScout now needs Node 22 or newer, because Node 20 is end of life. Upgrade Node before you update.
- Use CometScout from your AI client: an MCP server for setup, settings and the daily basics.
- Optional transcription of interview recordings on your own CPU, with speaker separation and a Russian engine.

### New

- An MCP server (node cli.mjs mcp) for Claude Desktop, Claude Code, Codex and other MCP clients: status, doctor, settings with validated dry-run changes, onboarding, today's picks, job search, status changes and adding a job. Secrets never pass through it: it gives a one-time link to a workspace form instead. README: Use it from an AI client (MCP).
- Transcription (optional module, node cli.mjs transcribe): speech to text on the machine's CPU with faster-whisper, a queue that runs one recording at a time at low priority, transcripts handed to the interview coach, upload from the workspace and the Telegram bot, and --bench to compare models.
- Russian recordings: GigaAM for Russian speech with Whisper's words for English terms and numbers, and a glossary built from your own CV library and profile.
- Speaker separation (optional): who said what, with your own voice recognised from a short sample; rename speakers with node cli.mjs transcribe --rename.
- Evals: label a sample of your jobs in the Label view (the verdict stays hidden while you label), then measure the decoder against your labels, compare two systems, and A/B packs and voice with a blind judge (node cli.mjs evals).

### Changed

- Node 22 or newer is required (package.json, deploy/install.sh, doctor); CI tests Node 22 and 24. The install guides add NodeSource's signed apt repository instead of piping its setup script into a root shell.
- The transcription module needs Python 3.11 or newer, because Python 3.10 is end of life. It now installs setuptools 81.0.0, which fixes a path traversal advisory (GHSA-5rjg-fvgr-3xxf).
- The interview coach is installed at one upstream commit that CometScout pins, never at the branch head, because its files are instructions your AI agent follows. An existing coach checkout is moved to that commit on the next install run; a fork named in modules.coach.repo still follows its own branch.
- hh.ru links are checked by the page's own archived marker only: every live hh.ru vacancy used to look archived, so none could become a pick.
- The update installs packages without running their install scripts, and the install guides clone a release tag instead of the branch head.
- Security: SECURITY.md says how to report a vulnerability privately; every change to CometScout now passes tests, secret scanning, dependency, licence and code scanning checks, and is signed.

### Action needed

- Upgrade Node to 22 or newer before you update: node -v shows the version, INSTALL.md (step 1) shows how. An install on Node 20 refuses this update and keeps running the version it has.
- If the transcription module runs on Python 3.10 (the default on Ubuntu 22.04): remove its venv folder and run its installer again with PYTHON set to a Python 3.11 or newer. node cli.mjs doctor says when this is needed.

## 0.1.0 (2026-10-05)

Needs Node 20 or newer. This version changes behaviour: read Changed before updating.

### Highlights

- The product has a new name: CometScout. Your data, settings and old names keep working.
- Choose the days and the time of your digest, from the workspace or from Telegram.
- Before an interview the digest helps you prepare instead of offering new roles.

### New

- Digest days and time (schedule.days, schedule.time): on other days the run still collects and decodes roles, but sends nothing; the next digest says what came in meanwhile.
- Interview prep mode (picks.prep): in the days before an interview the digest leads with it and shows at most one strong, fresh pick.
- node cli.mjs interview records a booked interview; the workspace has a button for it.
- A Telegram bot (node cli.mjs bot): /schedule with buttons, /time, /interview, /help. node cli.mjs timer installs it as a service when Telegram delivery is on.
- A settings dialog in the workspace for the digest days, time and prep window.
- Status accepted for a job you took and now work in: it closes the role for picks and dedupe, shows as Jobs I hold in the coach hand-off and as Offer in the tracker export. Emails never set or undo it.
- Updates: a check after the evening run, a Telegram message with Update now, Tonight and Skip, and node cli.mjs update, which backs up, installs side by side, migrates, verifies and rolls back by itself when anything fails. node cli.mjs rollback goes back by hand.
- What is new: after an update the workspace shows these notes once.

### Changed

- CometScout was called jobpilot until October 2026. The old names keep working until v0.3.0 at the earliest (the release that drops them will say so under Action needed): JOBPILOT_* variables are read when the COMETSCOUT_* one is not set, backups, exports and secrets files named jobpilot-* are listed, restored and imported, the jobpilot command and the X-Jobpilot header still work, and node cli.mjs timer replaces the old systemd units. doctor lists what is left to rename.
- New files, units, variables and log lines use the new name: cometscout-backup-*.zip, cometscout.service, cometscout.timer, cometscout-bot.service, COMETSCOUT_HOME and so on.
- settings.run_time is read as schedule.time; saving in the workspace or the bot moves it.

### Action needed

- When doctor lists variables from before the rename, rename them in .env to their COMETSCOUT_* names.
- Check your digest days and time. (setting: `schedule.time`)
