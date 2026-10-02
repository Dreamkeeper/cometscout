# Task briefs

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
