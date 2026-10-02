# 11: Export format v2 (ZIP) and backups

## Why
One archive serves four jobs: a user downloading their data, a nightly backup, moving to a new server, and restoring after a failed update (task 12). Today's format (`jobpilot-export-v1`, `lib/archive.mjs`) is a folder or a tar.gz made with the system `tar`; Windows Explorer cannot open a tar.gz, and the system `tar` is an outside dependency. Maintainer decision: the canonical container becomes ZIP, so a user can double-click their export and read their own files.

Read `DEVELOPMENT.md` first. Plain Node 20, no new dependencies, synthetic data only, no em dashes in user-facing text. Every change gets a test; `npm test` must pass on Linux and Windows.

## 1. `lib/zip.mjs` (no dependency)
- Writer: entries from files on disk, DEFLATE via `zlib.deflateRawSync` (STORE for files that do not shrink), UTF-8 names (general purpose flag bit 11), CRC-32 (implement the table), local headers, central directory, end record. ZIP64 when the archive or any entry passes 4 GiB or 65,535 entries (write it; tests can cover the trigger with a small forced threshold).
- Reader: central directory first, then entries; STORE and DEFLATE only (anything else is a clear error); CRC check on every entry; refuse names that are absolute, contain `..`, backslashes or drive letters (zip slip), and symlink entries.
- Streams large files instead of holding the whole archive in memory where practical (packs can hold PDFs).
- Tests: round trip of binary and UTF-8 (Cyrillic, Japanese) names; a zip written here opens with the system unzip / PowerShell `Expand-Archive` when present (skip with a reason otherwise); a zip made by the system zip reads back; corrupted CRC and zip-slip names are refused.

## 2. Format `jobpilot-export` v2
- `manifest.json`: `{ format: "jobpilot-export", version: 2, app_version, schema_version, exported_at, source_host, contents: ["data", "profile", "settings"], counts: { dir: n }, files: { "rel/path": sha256 } }`.
- Layout as v1: `data/{inbox,decoded,rejected,digests,packs,state}/...`, `profile/...`, `settings.json`. `.env`, `run.lock` and `backups/` are never included.
- `cli.mjs export --out <file.zip|folder> [--data-only]`: default now includes profile and settings (a backup must be complete); `--data-only` for the old behaviour. File names `jobpilot-export-<date>-v<app>.zip`.
- `cli.mjs import --from <file.zip|file.tar.gz|folder> [--dry-run] [--on-conflict keep|theirs|both] [--data-only]`: reads v2 zip, v1 tar.gz and folders; verifies every hash before writing anything; if the archive's `schema_version` is older than this install's, runs the data migrations on a temp copy first (the migration runner arrives with task 12: until then refuse a newer schema and accept equal ones); prints the plan (new, identical, conflicting files) and applies it only without `--dry-run`. `keep` leaves local files, `theirs` replaces them (the replaced files are saved to a backup first), `both` writes theirs next to mine as `<name>.imported-<date><ext>`. `settings.json` and `profile/` conflicts always need an explicit choice.
- Secrets: `cli.mjs export-secrets --out <file>` writes `.env` and the cookie/token state files (Hirify cookies, Gmail token) encrypted with a passphrase (scrypt + AES-256-GCM from `node:crypto`), read with `import-secrets`. Never part of a normal export or backup. The passphrase is read from the terminal or an env var, never an argument.
- One-way views next to the archive (not part of it): `cli.mjs export --csv <file>` writes applications as CSV (company, role, status, applied date, last activity, source, link, notes; UTF-8 with BOM so Excel opens Cyrillic correctly).

## 3. Backups
- `cli.mjs backup` writes a v2 zip to `backups/` under the jobpilot home (`backups/jobpilot-backup-<date>-<time>-v<app>.zip`), then prunes: keep 7 daily, 4 weekly and 6 monthly (newest of each period), never the newest three of any kind. `--label <text>` adds a label (task 12 uses `pre-update-v0.4.0`), and labelled backups are pruned only after 90 days.
- `cli.mjs run` makes a backup after the evening run (setting `backup.nightly`, default true); a failed backup is logged, alerts through the failure path, and does not fail the run.
- `cli.mjs backups` lists them (date, version, size, label). `cli.mjs restore <backup> [--dry-run]` is import with `--on-conflict theirs` plus a backup of the current state first, and refuses while the run lock is held.
- Optional offsite copy after each backup (`backup.copy_to`: a local path such as a Syncthing folder, or a command template with `{file}` for rsync/rclone): failures are logged, never fatal.
- `doctor`: last backup age (warn over 2 days when nightly is on), free disk space against the last backup size.

## Tests
Zip round trips and refusals above; export/import round trip equals byte for byte (hashes) for v2 zip, and v1 tar.gz still imports; dry-run plan and the three conflict modes; a newer schema is refused; secrets never appear in an export (scan the zip for `.env` names and for a planted secret value); encrypted secrets round trip and a wrong passphrase fails cleanly; pruning keeps the right set for a synthetic 120-day history; restore makes a backup first and respects the lock; CSV opens with the BOM and quotes commas and newlines.

## Done when
`npm test` passes on Linux and Windows; README "Export, import and backups" section replaces the v1 text (formats, what is and is not included, how to move to a new server in three commands, how to restore); `settings.example.json` gets the `backup` block; ROADMAP row. PR description lists what was built, what was not and open questions.
