# Task briefs

> Briefs 01 to 16 are kept as written, so they still say jobpilot, the name the product had before CometScout.

Self-contained pieces of work, written so a coding agent with only this repository (for example a cloud session) can finish them. Each brief says what to build, the behaviour to reproduce, the settings, the fixtures to test against and when it is done.

How to work on one:
1. Read `DEVELOPMENT.md` and the brief. Work on a branch named `task/<number>-<short-name>`.
2. Build it with tests against `test/fixtures/` (no network, no model calls in tests: inject `fetch` or the model call).
3. `npm test` passes; `node cli.mjs doctor` still runs on the example profile.
4. Open a pull request whose description lists what was built, what was not, and any open questions.

| # | Brief | Depends on |
|---|---|---|
| 01 | `01-gates.md` shared gates module | none |
| 02 | `02-hh-source.md` hh.ru alerts source | 01 (can stub the gates call) |
| 03 | `03-hirify-source.md` Hirify source | 01 (can stub) |
| 04 | `04-fetch-detail-and-drop-dir.md` full-text fetcher + external producer intake | none |
| 05 | `05-career-ops-source.md` career-ops source | 04 |
| 06 | `06-outcomes.md` outcome tracking from Gmail | none |
| 07 | `07-decoder-picks-parity.md` company aliases, dedupe against applications, decoder history and fact guard, picks parity | 01-06 merged |
| 08 | `08-pack-lint.md` lint rules from the profile for packs | none |
| 09 | `09-reports-and-ops.md` tracker export, source scorecard, health ping, failure alerts, Russian labels | none (uses 07 helpers when merged) |
| 10 | `10-workspace-today-screen.md` workspace probe: `cli.mjs serve` and the Today screen (Preact + htm, no build) | 01-09 merged |
| 11 | `11-export-v2-and-backups.md` export format v2 (ZIP, no dependency), import with conflict modes, encrypted secrets export, nightly backups and restore | none |
| 12 | `12-releases-and-updates.md` release notes, update check and notification (notify only), update with backup, migrations, verify and automatic rollback, manual rollback, What is new | 11 |
| 13 | `13-coach-onboarding.md` interview coach as an optional onboarding step: upstream installer, hand-off file from the profile, CV library, voice and applications | none |
| 14 | `14-accepted-status.md` status "accepted" for jobs the user holds: hand-off section, Today and follow-ups skip them, tracker and scorecard mapping | none |
| 15 | `15-digest-days-and-interview-prep.md` digest days and time as settings (workspace + Telegram bot commands), off days decode silently, interview prep mode before new applications, interview date and time recording | 14 |
| 16 | `16-rename-to-cometscout.md` rename the product to CometScout in code, units, env vars, file names and docs, old names kept working for a release or two | 15 |
| 17 | `17-evals-and-labelling.md` label sets, the Label view (verdict hidden), decode eval (confusion, precision/recall, replay with history cutoff, paired compare), pack A/B judge, voice judge | none |
| 18 | `18-transcription-module.md` optional CPU transcription (faster-whisper in its own venv): inbox, queue one at a time at low priority, transcripts to the coach, upload in the workspace and the bot, --bench | none |
| 19 | `19-install-rehearsal-and-ci.md` tools/rehearse: the new-user path on a fresh Debian/Ubuntu (install, units, run, workspace, backup, export, update, rollback, old-name migration), plus CI: npm test on Linux and Windows, the rehearsal on install changes and weekly | 18 |
| 20 | `20-russian-engine-merge-and-glossary.md` Russian recordings: GigaAM v3 (Silero VAD chunks, no account), a targeted merge with Whisper for English terms and numbers, a glossary from the user's own data (Whisper hotwords + sound match), review items never applied | 18 |
| 22 | `22-mcp-server-mvp.md` MCP server over stdio (SSH for a VPS): status, doctor, settings get/schema/set with dry-run diffs, onboarding state, today, job search, status changes, add job; secrets only through a one-time workspace form; scopes and an audit log | none |
