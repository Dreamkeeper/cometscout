# Developing jobpilot

This file is for people (and coding agents) working on jobpilot itself. `AGENTS.md` is different: it is the script an agent follows to set jobpilot up for a user. If you are changing the code, follow this file and ignore the onboarding steps in `AGENTS.md`.

## Ground rules

- **Generic and settings-driven.** Everything in this repo must work for any job seeker. Behaviour that depends on a person (their countries, languages, gates, companies, prompts) lives in `settings.json` or `profile/`, never in code. Personal integrations (writing to someone's notes, a private tracker) use hooks (`settings.hooks`) and live outside this repo.
- **No personal data.** No real names, emails, phone numbers, tokens, CV text or real job-search records in code, tests, fixtures or docs. `profile.example/` is fictional. Test fixtures are synthetic (see `test/fixtures/README.md`).
- **No dependencies.** Node 20+ built-ins only (plus Python 3 for `pack/pack.py`). Ask before adding a package.
- **Secrets stay in `.env`.** Never log them; model calls run with `modelEnv()` and their output is checked against `SECRET_VALUES()` (`lib/config.mjs`, `lib/llm.mjs`).
- **Fail loudly on config errors, never silently drop data.** Use `readConfig()` for user-edited JSON and `num()` for every number setting. A source that cannot read something it would normally mark as seen must not mark it seen.
- **Plain, short prose** in user-facing text (digest, doctor, docs). No em dashes.

## Layout

| Path | What |
|---|---|
| `cli.mjs` | Every command (`run`, `sources`, `decode`, `pack`, `picks`, `applied`, `status`, `list`, `doctor`, `timer`, `reset`, `export`, `import`, `export-secrets`, `import-secrets`, `backup`, `backups`, `restore`, `tracker-export`, `sources-report`, `notify`) |
| `lib/config.mjs` | Settings, profile, `.env`, data dirs, `num()`, `today()`, model environment |
| `lib/queue.mjs` | Job files: `writeJob`, `loadJob`, `alreadyQueued` (dedupe), `matchesAny` (filters), `parseResult` |
| `lib/llm.mjs` | `callJson()` for Claude Code or Codex with a JSON schema |
| `lib/hooks.mjs` | `runHook(event, payload)` |
| `lib/lint.mjs` | Lint rules from `profile/lint-rules.json`: paragraphs from a DOCX, hits, report, CLI |
| `lib/archive.mjs` | Export / import (`jobpilot-export` v2 zip or folder; reads v1 folders and tar.gz), conflict modes |
| `lib/zip.mjs` | ZIP reader and writer on `node:zlib` (DEFLATE/STORE, UTF-8 names, CRC-32, ZIP64, zip-slip refusals) |
| `lib/backup.mjs`, `lib/secrets.mjs`, `lib/csv.mjs` | Backups (prune, restore, offsite copy, doctor lines), encrypted `.env` export, applications as CSV |
| `lib/archive-cli.mjs` | The export, import, secrets and backup commands of `cli.mjs` |
| `lib/telegram.mjs`, `lib/gmail.mjs` | Delivery, read-only Gmail |
| `lib/i18n.mjs` | `settings.locale` label tables (`en`, `ru`) for the digest, picks, pack messages and the scorecard's Telegram text |
| `lib/tracker.mjs`, `lib/scorecard.mjs`, `lib/sightings.mjs` | Tracker export, source scorecard, the sightings log `writeJob` keeps for it |
| `lib/ops.mjs` | Health ping, `notify`, the systemd units (`deploy/jobpilot-failure@.service`) |
| `lib/match.mjs` | Company and role matching for reports (uses `lib/companies.mjs` when it exists) |
| `sources/*.mjs` | One file per source; each writes job files with `writeJob()` |
| `decoder/` | Verdicts, picks, digest (`digest.mjs` renders the text) |
| `pack/` | Tailored CV, cover letter, form answers (`message.mjs` is the Telegram text) |
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

## Before you open a pull request

- `npm test` passes, and new behaviour has tests.
- `node cli.mjs doctor` still runs on the example profile.
- `git grep -n -i -E "<your real name>|<your email>"` finds nothing.
- The commit message says what changed and why, in plain words.
