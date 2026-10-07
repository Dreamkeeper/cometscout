# 19: Install rehearsal and CI

## Why
Most of CometScout's code is covered by unit tests, but nothing checks the path a new user actually takes: a fresh Debian or Ubuntu server, `deploy/install.sh`, the timer and bot units, the first run, an update, a backup and a restore. Bugs there cost a new user their first evening, and the maintainer's own test server is about to be set up the same way. The repository also has no CI at all, so a change that breaks Windows or Linux is only found by hand.

Read `DEVELOPMENT.md` first. Plain Node 20 and bash, no new dependencies, synthetic data only (the example profile), no em dashes in user-facing text. `npm test` must still pass on Linux and Windows.

## 1. `tools/rehearse/rehearse.sh`
A script that runs on a fresh Debian 12/13 or Ubuntu 22.04/24.04 machine with systemd, as a normal user with sudo, and walks the new-user path end to end. It never needs a real model, Telegram, Gmail or job board: it sets `COMETSCOUT_LLM_FAKE` for its own runs only (never writes it to `.env`, which CometScout ignores anyway), turns Telegram and every network source off, and feeds the run from the drop-dir source with a few synthetic job files.

Steps, each printed as PASS or FAIL with timing, and a summary at the end (non-zero exit on any FAIL):
1. Install: `bash deploy/install.sh` from a checkout of the given ref (`--ref <tag|branch|sha>`, default the current checkout), non-interactive.
2. Layout: `app/releases/<version>` and `app/current` exist; `node cli.mjs doctor` has no unexpected TODO (the expected ones for an install without a real profile are listed in the script).
3. Profile: copy `profile.example` to `profile/`, settings for the drop-dir source and a fixed schedule; `doctor` again.
4. Units: `systemctl --user` shows `cometscout.timer` enabled with the right time; `cometscout-failure@.service` present; lingering enabled for the user.
5. One evening run (`node cli.mjs run`, started through the service with `systemctl --user start cometscout.service` and waited for): the synthetic jobs are decoded (canned verdicts), picks and the digest file written, a pack built for a pick, no Telegram call attempted.
6. Workspace: `node cli.mjs serve --check`, then start `serve` on a free port, fetch `/` and `/api/today`, stop it.
7. Backup and restore: `backup`, change a file, `restore --dry-run` lists it, `restore` brings it back.
8. Export and import into a second fresh home: round trip with the same file hashes.
9. Update: adopt is a no-op on an installed layout; `update --to <the same version>` refused cleanly; with `--from-zip <path>` (a test hook that installs a locally built source zip of the next version instead of downloading it, with its sha256) an update to a fake next version runs backup, install, migrate, switch, verify; `rollback` returns to the first version; the units still point at `app/current`.
10. Old-name migration: create the timer and service user units from before the rename (their names come from `OLD_UNITS` in `lib/legacy-names.mjs`), run `cli.mjs timer`, check they are gone and the new ones enabled.
11. Uninstall check: a documented `tools/rehearse/cleanup.sh` disables the units and removes the test home, so the script can run on a machine that is kept.

`--keep` leaves the install in place for a look. The script never touches anything outside the test home and the user's systemd units it created.

## 2. CI (`.github/workflows/`)
- `test.yml`: `npm ci && npm test` on `ubuntu-latest` and `windows-latest`, Node 20 and 22, on pushes to main and on pull requests.
- `rehearse.yml`: `tools/rehearse/rehearse.sh` on `ubuntu-24.04` (lingering and the user systemd session set up in the job), on pull requests that touch `deploy/`, `lib/ops.mjs`, `lib/update.mjs`, `lib/layout.mjs`, `lib/backup.mjs`, `lib/archive.mjs` or `cli.mjs`, on pushes to main, and weekly. Upload the rehearsal log as an artifact.
- Both use only official actions (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`) pinned by tag, no secrets, read-only token permissions.
- README: CI badges for both workflows.

## 3. Fix what the rehearsal finds
Anything the rehearsal finds broken in the install, units, run, workspace, backup, export or update path is fixed in this task, each with a unit test where one fits. The PR lists every fix.

## Tests
The script's helper functions (version bump for the fake next release, the zip builder, the PASS/FAIL report) get unit tests that run on both platforms; the script itself is exercised by `rehearse.yml`. Run it once in a fresh environment before opening the PR (a container or VM with systemd, or a fresh WSL distro with systemd enabled) and paste the summary into the PR.

## Done when
`npm test` passes on Linux and Windows; `rehearse.yml` and `test.yml` are green on the PR; the rehearsal summary from one fresh machine is in the PR description. PR description lists what was built, what the rehearsal found and fixed, what was not done, and open questions.
