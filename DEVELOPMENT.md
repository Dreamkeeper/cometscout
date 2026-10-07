# Developing CometScout

> CometScout was called jobpilot until October 2026. Old names that installs still supply are read through `lib/legacy-names.mjs` only (see the rule below).

This file is for people (and coding agents) working on CometScout itself. `AGENTS.md` is different: it is the script an agent follows to set CometScout up for a user. If you are changing the code, follow this file and ignore the onboarding steps in `AGENTS.md`.

## Ground rules

- **Generic and settings-driven.** Everything in this repo must work for any job seeker. Behaviour that depends on a person (their countries, languages, gates, companies, prompts) lives in `settings.json` or `profile/`, never in code. Personal integrations (writing to someone's notes, a private tracker) use hooks (`settings.hooks`) and live outside this repo.
- **No personal data.** No real names, emails, phone numbers, tokens, CV text or real job-search records in code, tests, fixtures or docs. `profile.example/` is fictional. Test fixtures are synthetic (see `test/fixtures/README.md`).
- **No dependencies.** Node 20+ built-ins only (plus Python 3 for `pack/pack.py`). Ask before adding a package. The one exception is the workspace's browser code: `preact` and `htm`, pinned to exact versions in `package.json`, installed by `npm install` and served from `node_modules` (never copied into the repo, no CDN). The server and everything else stay dependency-free.
- **Secrets stay in `.env`.** Never log them; model calls run with `modelEnv()` and their output is checked against `SECRET_VALUES()` (`lib/config.mjs`, `lib/llm.mjs`).
- **Fail loudly on config errors, never silently drop data.** Use `readConfig()` for user-edited JSON and `num()` for every number setting. A source that cannot read something it would normally mark as seen must not mark it seen.
- **Plain, short prose** in user-facing text (digest, doctor, docs). No em dashes.
- **New names only.** Write and print CometScout (`cometscout` as an identifier). A fallback for a name from before the rename goes in `lib/legacy-names.mjs`; `test/names.test.mjs` fails on the old name anywhere else (the few places that cannot import it are listed in that test).

## Layout

| Path | What |
|---|---|
| `cli.mjs` | Every command (`run`, `sources`, `decode`, `pack`, `picks`, `applied`, `status`, `list`, `doctor`, `timer`, `reset`, `export`, `import`, `export-secrets`, `import-secrets`, `backup`, `backups`, `restore`, `tracker-export`, `sources-report`, `notify`, `serve`, `mcp`, `coach-handoff`, `interview`, `bot`, `transcribe`, `update`, `rollback`, `migrate`, `evals`) |
| `lib/config.mjs` | Settings, profile, `.env`, data dirs, `num()`, `today()`, model environment |
| `lib/queue.mjs` | Job files: `writeJob`, `loadJob`, `alreadyQueued` (dedupe), `matchesAny` (filters), `parseResult` |
| `lib/llm.mjs` | `callJson()` for Claude Code or Codex with a JSON schema |
| `lib/applications.mjs` | Writes to `applications.json`: `setStatus` (the CLI's `applied` / `status` and the workspace's `POST /api/status`), `addLater`, `laterUntil`, `addInterview` (`cli.mjs interview`, `POST /api/interview`, the bot) |
| `lib/lock.mjs` | The run lock (`data/state/run.lock`): `takeLock` for the commands, `lockHolder` for the workspace's writes |
| `lib/workspace.mjs`, `lib/server.mjs` | The workspace: API payloads (today, job, pack, labels, status, later, pack files, label sets for `/label`) and the `node:http` server behind `cli.mjs serve` |
| `web/` | The workspace's browser code, no build step: `index.html` (import map), `app.js`, `components/` (Preact + htm), `lib/` (pure logic with no DOM, tested by `node --test`), `styles.css` |
| `lib/schedule.mjs` | `settings.schedule` (digest days and time, `offDay`) and `picks.prep` (`prepState`, `prepQualifies`), interview dates from events |
| `lib/settings-writer.mjs`, `lib/jsonedit.mjs` | The one writer for settings the workspace and the bot change: validates like doctor, edits only those values in settings.json, reinstalls the timer on a time change; `setSetting` (one value by its path, with a unified diff) is what the MCP server's `settings_set` writes through |
| `lib/settings-schema.mjs` | Every known setting (type, default, allowed values, one line of help, locked or not) and `SOURCES`; `settingsProblems` is doctor's settings checks on a settings object. A new setting needs a row here: `test/settings-schema.test.mjs` fails when doctor reads a key the table lacks |
| `lib/doctor.mjs` | `doctorItems()`: the doctor check as items { level, text, fix }; `cli.mjs doctor` prints them (`--json` as JSON) |
| `lib/run-log.mjs` | `data/state/runs.jsonl`: one line per evening run (sources and their exits, counts, failures) for the MCP server's status and run_log |
| `lib/mcp.mjs`, `lib/mcp-tools.mjs` | The MCP server (`cli.mjs mcp`): JSON-RPC over stdio written by hand (MCP 2026-07-28, plus initialize for older clients), scopes, and the tools, resources and prompts. Writes go through the writers above, check the run lock and append to `data/state/mcp-log.jsonl`; stdout is protocol only |
| `lib/env-names.mjs` | Environment variable names: the names `.env` may never set (start-up, proxy, certificate and `COMETSCOUT_*` names; `lib/secrets.mjs` refuses to write them and `lib/config.mjs` to load them), the fixed list of secrets CometScout reads (the only names a secrets link offers), and `secretEnvName`, the checked name behind every `*_env` setting (never another feature's secret). Read a `*_env` setting through it, never directly |
| `lib/secrets-form.mjs`, `web/secrets.js` | Which secrets each feature needs (never the values), and the one-time links behind the workspace's `/secrets` page, which writes `.env` through `lib/secrets.mjs` |
| `lib/bot.mjs` | The Telegram bot (`cli.mjs bot`): `COMMANDS` and `BUTTONS` tables, a transport injected in tests, the long-poll loop |
| `lib/hooks.mjs` | `runHook(event, payload)` |
| `lib/legacy-names.mjs` | Every fallback for a name from before the rename: environment variables, the workspace header, systemd units, backup, export and secrets names |
| `lib/lint.mjs` | Lint rules from `profile/lint-rules.json`: paragraphs from a DOCX, hits, report, CLI |
| `lib/archive.mjs` | Export / import (`cometscout-export` v2 zip or folder; reads v1 folders and tar.gz), conflict modes |
| `lib/zip.mjs` | ZIP reader and writer on `node:zlib` (DEFLATE/STORE, UTF-8 names, CRC-32, ZIP64, zip-slip refusals) |
| `lib/backup.mjs`, `lib/secrets.mjs`, `lib/csv.mjs` | Backups (prune, restore, offsite copy, doctor lines), encrypted `.env` export, applications as CSV |
| `release.json`, `CHANGELOG.md`, `tools/changelog.mjs`, `lib/release.mjs` | Release notes, one entry per version (the only source); the changelog and GitHub release texts are generated from it; versions, validation, notes per locale |
| `lib/layout.mjs` | Where the code lives: `app/releases/vX.Y.Z/` in the home and the `app/current` link, file lists for local edits, pruning, `update --adopt` |
| `lib/update.mjs`, `lib/update-cli.mjs` | The update check (GitHub releases API, channels, cache), the notice and buttons, the detached launch, `update` (preflight, backup, install, migrate, switch, verify, rollback), `rollback`, What is new |
| `lib/migrate.mjs`, `migrations/` | Data migrations: `migrations/NNN-name.mjs` exporting `{ id, up(ctx) }`, applied once each, recorded in `data/state/schema.json` |
| `lib/archive-cli.mjs` | The export, import, secrets and backup commands of `cli.mjs` |
| `lib/telegram.mjs`, `lib/gmail.mjs` | Delivery, read-only Gmail |
| `lib/i18n.mjs` | `settings.locale` label tables (`en`, `ru`) for the digest, picks, pack messages and the scorecard's Telegram text |
| `lib/tracker.mjs`, `lib/scorecard.mjs`, `lib/sightings.mjs` | Tracker export, source scorecard, the sightings log `writeJob` keeps for it |
| `lib/ops.mjs` | Health ping, `notify`, the systemd units (`deploy/cometscout-failure@.service`) |
| `lib/match.mjs` | Company and role matching for reports (uses `lib/companies.mjs` when it exists) |
| `sources/*.mjs` | One file per source; each writes job files with `writeJob()` |
| `decoder/` | Verdicts, picks, digest (`digest.mjs` renders the text; `finishRun` handles off days and prep mode) |
| `pack/` | Tailored CV, cover letter, form answers (`message.mjs` is the Telegram text) |
| `evals/` | Evals (`cli.mjs evals`): `sets.mjs` (label sets: sampling, `labels.jsonl`, what the labelling screen may show), `decode.mjs` (verdicts against labels, replay, compare), `pack.mjs` and `voice.mjs` (model judges), `packs.mjs` (reading pack folders), `stats.mjs` (seeded random, McNemar), `cli.mjs` (arguments). Everything they write goes under `data/evals/` |
| `lib/coach.mjs`, `deploy/modules/` | The interview coach module: installer (`coach.sh`, `coach.ps1` both run `node lib/coach.mjs install`), doctor lines, the hand-off file |
| `lib/transcribe.mjs`, `deploy/modules/transcribe*` | The transcription module: installer (`transcribe.sh`, `transcribe.ps1` both run `node lib/transcribe.mjs install`: a venv with a pinned faster-whisper and the pinned libraries in `transcribe/constraints.txt`), `transcribe/transcribe.py` (one file in, JSON segments out, `--engine whisper|gigaam`, `--engines` to detect the language on speech and transcribe in one process), `cli.mjs transcribe`, engines per language, the queue and its lock, outputs, doctor lines, the path unit, `--with-gigaam` (CPU-only PyTorch and GigaAM pinned to a commit). Tests use a fake transcriber through `COMETSCOUT_TRANSCRIBE_CMD`; Python is only ever inside the module's venv |
| `lib/transcribe-merge.mjs`, `lib/transcribe-glossary.mjs` | Pure Node: the targeted merge of GigaAM's and Whisper's words (alignment, the Latin and number rules, review items, subtitle segments) and the glossary from the user's own data (building, hotwords, the sound match on GigaAM's words) |
| `lib/transcribe-speakers.mjs`, `lib/transcribe-speakers-bench.mjs` | Speaker separation (`modules.transcribe.speakers`, the `--with-speakers` extra): the pinned sherpa-onnx models (URLs, sha256, verified downloads), words to speakers (overlap, the midpoint rule), segments broken at speaker changes, "Me" from the voice sample, labels and `speakers.json` names, overlap marks; the bench (`--bench-speakers`): synthetic two-speaker calls from public read speech, DER, "Me" accuracy. `transcribe.py --diarize` and `--convert` are the Python side; tests use the fake diarizer in `test/fixtures/transcribe/` |
| `tools/` | `gmail-auth.mjs`; `workspace-demo.mjs` (demo data for the workspace) and `text-pdf.mjs` (small text PDFs for it and the tests) |
| `tools/rehearse/` | The install rehearsal: `rehearse.sh` (the new-user path on a fresh Debian or Ubuntu machine with systemd, step by step, PASS or FAIL), `cleanup.sh`, and `lib.mjs` (its helpers: the fake next version and its source zip, settings, the canned model answer, synthetic jobs, expected doctor TODOs, the report) |
| `.github/workflows/` | CI: `test.yml` (`npm test` on Linux and Windows, Node 20 and 22) and `rehearse.yml` (the rehearsal on Ubuntu 24.04, weekly and when the install, update or backup code changes) |
| `test/` | `node --test` unit tests; `test/fixtures/` synthetic inputs |
| `ROADMAP.md` | Milestones and what is in progress |
| `docs/tasks/` | Self-contained task briefs (good for cloud sessions) |

## Adding a source

1. `sources/<name>.mjs`, enabled by `settings.sources.<name>.enabled`; register it in `SOURCES` in `cli.mjs` and add a `doctor` line for anything it needs (tokens, cookies).
2. Fetch, filter with `matchesAny` and the shared gates, write with `writeJob({ company, role, url, source, location, text, extra })`.
3. Keep its own state in `data/state/<name>*.json`; never mark an item seen when it could not be read.
4. `--dry-run` must write nothing.
5. Tests with synthetic fixtures under `test/fixtures/<name>/`; no network in tests (inject `fetch` or read fixtures).
6. Document the settings keys in the file header, `settings.example.json` (disabled by default) and `README.md`.

## Data migrations

A release that changes stored data ships a migration: `migrations/NNN-name.mjs` (the next free number) exporting `id` (the file name without `.mjs`) and `async up(ctx)`, and lists the id in its `release.json` entry. `ctx` has `root`, `data`, `state(name)`, `settingsFile`, `readJson`, `writeJson` (atomic) and `log`. `node cli.mjs migrate` (an update runs the new release's own) applies the ones `data/state/schema.json` does not list yet, in order, and records each right after it ran. Write each one so it can run again safely (check before you write).

**Expand, then contract.** A release only adds files and fields that the previous release ignores. Removing or renaming a file or a field waits for the release after that, once no supported version reads the old shape. So the previous release always runs on the newer data, and switching the code back (`cli.mjs rollback`, or an update that failed its checks) is always safe. A migration never deletes or rewrites data the previous release needs.

## Install rehearsal

`bash tools/rehearse/rehearse.sh` walks the path a new user takes on a fresh Debian 12/13 or Ubuntu 22.04/24.04 machine with systemd, as a normal user with passwordless sudo: `deploy/install.sh`, the layout and doctor, a profile and settings, the units, one evening run through `systemctl --user start cometscout.service`, the workspace, backup and restore, export and import into a second home, an update from a locally built source zip (`update --from-zip`, a test hook) and a rollback, the units from before the rename, and cleanup. No model, Telegram, Gmail or job board: three synthetic jobs go through the drop-dir source and the model is a canned answer (`COMETSCOUT_LLM_FAKE`, set only for its own run). `--ref <tag|branch|sha>` installs another commit, `--keep` leaves everything for a look (`tools/rehearse/cleanup.sh` removes it). It refuses to start where CometScout units are already installed for the user. CI runs it in `.github/workflows/rehearse.yml`; run it yourself in a throwaway VM, container or WSL distro with systemd when you change the install, units, update or backup code.

## Releases

`docs/RELEASING.md` is the maintainer's checklist: the `package.json` version, the `release.json` entry (`test/release.test.mjs` fails without it), `node tools/changelog.mjs`, the tag and the GitHub release with its sha256.

## Before you open a pull request

- `npm test` passes, and new behaviour has tests.
- `node cli.mjs doctor` still runs on the example profile.
- `git grep -n -i -E "<your real name>|<your email>"` finds nothing.
- The commit message says what changed and why, in plain words.
