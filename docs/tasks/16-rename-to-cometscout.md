# 16: Rename jobpilot to CometScout in the code

## Why
The product is now CometScout (repository `Dreamkeeper/cometscout`, site cometscout.com), but the code, units, environment variables, file names and most docs still say jobpilot. Every later task (releases and updates first) would add more old names and would have to migrate them later. Rename now, before anyone else installs it, and keep the old names working for a release or two so existing installs (the maintainer's own) do not break.

Maintainer decision (D42): command and product name `cometscout`; `jobpilot` stays as an alias for a release or two.

Read `DEVELOPMENT.md` first. Plain Node 20, no new dependencies, synthetic data only, no em dashes in user-facing text. Every change gets a test; `npm test` must pass on Linux and Windows.

## Rules
- **New names everywhere we write or print:** product name in text "CometScout"; identifiers `cometscout` (lowercase).
- **Old names keep working wherever a user or an existing install supplies them** (read both, write new), until a later release removes them. Each fallback is one small helper, not scattered `||` chains, and is listed in one place (`lib/legacy-names.mjs` or a section of `lib/config.mjs`) so removing them later is one change.
- No data is renamed or moved silently. Where an install has old-named files or units, the new code finds them, and `doctor` says what to migrate and the command that does it.

## What to rename
- `package.json` name; CLI usage text and `--help`; log prefixes ("jobpilot:" → "cometscout:"); the HTTP header `X-Jobpilot` → `X-CometScout` (the server accepts both; the web client sends the new one).
- Environment variables `JOBPILOT_*` → `COMETSCOUT_*` (HOME, DATA, SETTINGS, RUN_DATE, SECRETS_PASSPHRASE, EVENING, TIME, EVENT and any others). Read the new one first, then the old one. Hooks receive both names in their environment for this release, so user hook scripts keep working.
- systemd units `jobpilot.service`, `jobpilot.timer`, `jobpilot-failure@.service`, `jobpilot-bot.service` → `cometscout*`. `cli.mjs timer` installs the new units and, when it finds the old ones, disables and removes them (stopping the old timer first) and says so. `doctor` reports old units still installed.
- File names CometScout creates: backups `cometscout-backup-*.zip`, secrets `cometscout-secrets*`, exports `cometscout-export-*.zip`, temp folder prefixes. Restore, import and the backup pruner accept the old names too (pruning must never delete the other name's newest backup by mistake: prune per name family, keep the newest of each).
- The export format id: write `cometscout-export` v2; import accepts `cometscout-export` v2, `jobpilot-export` v2 and `jobpilot-export-v1`. Add a test with each.
- The install scripts (`deploy/install.sh`, `deploy/modules/*`): new paths and names; an existing `~/jobpilot` style install is detected and left in place, with a message on how to move it.
- A `cometscout` command: a tiny bin entry in `package.json` pointing at `cli.mjs`, plus a `jobpilot` entry pointing at the same file for now. Docs use `node cli.mjs` and `cometscout` consistently.
- Docs: README.md, README-rus.md, INSTALL.md, AGENTS.md, CLAUDE.md, DEVELOPMENT.md, ROADMAP.md, docs/tasks/README.md: the product is CometScout; keep one short line saying it was called jobpilot and the old names still work for now. Older task briefs (01 to 15) stay as written (history), with one line at the top of docs/tasks/README.md saying so.
- i18n strings (English and Russian) that name the product.

## Out of scope
The GitHub repository is already renamed. The maintainer renames his local folders himself. Do not change the meaning of any setting.

## Tests
- Each env var: new name wins, old name works alone.
- Header: the server accepts `X-CometScout` and `X-Jobpilot`; a request with neither is refused as before.
- Timer install with old units present: new units written, old ones disabled and removed (fake systemctl, as the existing timer tests do); doctor lines for leftover old units.
- Backups: new file names; restore and pruning with a mix of old and new names.
- Import: the three accepted format ids; export writes the new one.
- A grep test (or a lint script run by `npm test`) that fails on any new `jobpilot` in code outside the legacy-names module, tests, old task briefs and the one history line in the docs.

## Done when
`npm test` passes on Linux and Windows; `node cli.mjs doctor` runs on the example profile; README and the install guides describe CometScout. PR description lists what was renamed, every legacy fallback kept and where, what was not done, and open questions.
