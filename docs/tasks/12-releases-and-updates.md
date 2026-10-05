# 12: Releases, update notifications, update and rollback

## Why
Self-hosted installs rot unless updating is one tap and cannot lose data. Maintainer decisions: updates are **notify only** (nothing installs without the user's tap); every update makes a backup first, verifies itself and rolls back automatically on failure; data changes never break the previous version (expand, then contract); users learn what changed in plain language.

Depends on task 11 (backups, export v2) and task 16 (the rename). Updated 2026-10-05 after tasks 15 and 16: use the CometScout names (`COMETSCOUT_*`, `cometscout*` units, `cometscout-backup-*`), keep reading the legacy names through `lib/legacy-names.mjs`, and use the bot and settings dialog that now exist. Read `DEVELOPMENT.md` first. Plain Node 20, no new dependencies, synthetic data only, no em dashes in user-facing text. Every change gets a test; `npm test` must pass on Linux and Windows (the update itself targets Linux servers; tests that need symlinks use a junction or skip with a reason on Windows).

## 1. Release metadata
- `release.json` at the repo root, one entry per version, newest first: `{ version, date, min_node, schema_version, migrations: ["003-..."], behaviour_changes: true|false, notes: { highlights: [...], new: [...], changed: [...], action_needed: [{ text, setting }] }, media: [{ path, alt }] }`. `CHANGELOG.md` is generated from it (`node tools/changelog.mjs`), so there is one source. Notes in en; ru optional (`notes_ru`), falling back to en.
- `docs/RELEASING.md`: bump `package.json` version, add the `release.json` entry, run tests, tag `vX.Y.Z` (annotated; signed when the maintainer has a key), push the tag, create the GitHub release with the generated notes and a sha256 of the source zip.
- A test fails when `package.json`'s version has no `release.json` entry or the entry is malformed.

## 2. Install layout
- The CometScout home (data, settings, profile, `.env`, `backups/`) stays where it is. Code moves to `app/releases/vX.Y.Z/` inside the home, with `app/current` pointing at the active release (a symlink, swapped atomically with rename). `deploy/install.sh` installs this way; systemd units run `app/current/cli.mjs` with `COMETSCOUT_HOME` set (already supported by `unitFiles`).
- `cli.mjs update --adopt` converts an existing git-clone install in place: copies the current code into `app/releases/<its version>/`, points `app/current` at it, regenerates the units. Nothing in data moves. Idempotent.
- Each release folder gets its own `npm ci --omit=dev` (preact and htm for the workspace).

## 3. Update check and notification
- After the evening run (and `cli.mjs update --check`): ask the GitHub releases API for the newest release on the channel (`update.channel`: `stable` = tags without a pre-release suffix, `edge` = pre-releases too). No token; a failure is logged once a day, never fatal. Cache the answer in `data/state/update.json`.
- When a newer version exists and was not skipped: a Telegram message (three lines: version, the first highlights, "behaviour changes" when set) with inline buttons Update now / Tonight after the run / Skip this version, and the same banner in the workspace PWA (`/api/update`). Buttons map to `cli.mjs update --to vX`, `--tonight` (sets `update.pending`, applied by the next run after it finishes) and `--skip vX`. The bot exists since task 15 (`lib/bot.mjs`, `cli.mjs bot`): add the three callback buttons there (only the configured chat, validated callback data, `Object.hasOwn` lookups, no edit when nothing changed), plus `/update` showing the current and newest version. When the bot service is not running, the message also carries the commands to type. An update started from the bot must survive the bot unit being restarted by the update itself: run it detached (`systemd-run --user` or a one-shot `cometscout-update.service`), never inside the bot process.
- Never auto-install (no setting for it).

## 4. `cli.mjs update [--to vX.Y.Z] [--tonight] [--skip vX.Y.Z]`
1. Preflight: not while the run lock is held; Node satisfies `min_node`; free disk space at least 3x the last backup; no local edits in `app/current` (compare with the release's file list); the target tag exists; the downloaded source zip matches the release's sha256 (or the tag's signature when signed).
2. Backup: `cli.mjs backup --label pre-update-vFROM-to-vTO`.
3. Install side by side into `app/releases/vTO/` (download the tag's source zip, unpack with `lib/zip.mjs`, `npm ci --omit=dev`).
4. Migrate: ordered, idempotent scripts `migrations/NNN-name.mjs` exporting `{ id, up(ctx) }`; `data/state/schema.json` records `{ version, applied: [ids] }`. Rule written into DEVELOPMENT.md: a release only adds files and fields the previous release ignores; removing or renaming waits for the next release (expand, then contract), so switching code back is always safe.
5. Switch `app/current` to vTO, regenerate the systemd units (`cli.mjs timer`).
6. Verify with the new code: `doctor` (no failures), `serve --check`, `decode --dry-run` on one decoded job with the model call replaced by a canned answer (`COMETSCOUT_LLM_FAKE`), picks dry run. Any failure: switch `app/current` back, restore the pre-update backup (nothing new was written yet), regenerate units, notify "update to vTO failed at <step>, rolled back to vFROM", keep the failed release folder for a look.
7. Success: record it in `data/state/update.json`, set `whats_new_pending: vTO` for the PWA, notify, prune release folders (keep the current and the two before it).

## 5. `cli.mjs rollback [--to vX.Y.Z] [--restore-data]`
- Default: switch code back to the previous release and regenerate units (safe by the expand/contract rule).
- `--restore-data`: first list what would be lost since the pre-update backup (new or changed files by folder, application events by company), ask for confirmation (`--yes` for scripts), back up the current state, restore, then offer to re-import the listed newer items from that fresh backup with `--on-conflict keep`.
- Refuses while the run lock is held.

## 6. "What's new" in the product
- `/api/whats-new` returns the notes between the version the user last saw and the current one; the workspace shows them once after an update (highlights with media, New, Changed, Action needed with a button that opens the settings dialog from task 15 at the named setting). Settings changes that alter behaviour list "new default X; your value Y kept" with keep / accept.
- Telegram gets the three-line summary and a link to the screen.

## Tests
release.json validation; the GitHub check against a canned API response (stable vs edge, skipped versions, cache); update end to end in a temp home with two local fake releases (zip files and a fake "download" function): backup made, migration applied once, switch, verify; a migration that throws and a verify that fails both roll back to the exact previous state (hash the home before and after); `--tonight` applied after a run; rollback default and `--restore-data` with the lost-items list; adopt of a git-clone layout; lock refusals.

## Done when
`npm test` passes on Linux and Windows; README "Updates" section (how notifications work, what an update does, how to roll back, the expand/contract promise); DEVELOPMENT.md migration rule; `docs/RELEASING.md`; first `release.json` entry for the current version, whose notes cover the rename (what changed, which old names still work and until when) and tasks 14 and 15; ROADMAP row. PR description lists what was built, what was not and open questions.
