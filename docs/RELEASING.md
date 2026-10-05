# Releasing CometScout

For the maintainer. A release is a git tag `vX.Y.Z` and a GitHub release with notes generated from `release.json`. Installs learn about it from the GitHub releases API after their evening run (`lib/update.mjs`) and install it only when their user taps Update now or Tonight, or runs `node cli.mjs update`.

`stable` installs see tags without a pre-release suffix (`v0.2.0`); `edge` installs also see pre-releases (`v0.3.0-beta.1`). Mark a pre-release as one on GitHub too.

## Steps

1. **Version.** Set `version` in `package.json` (semver; `npm version --no-git-tag-version 0.2.0` also updates `package-lock.json`).
2. **Notes.** Add the entry to the top of `release.json`, newest first:
   - `version` (no "v"), `date` (the day you tag), `min_node`, `schema_version` (the data schema of this code, `SCHEMA_VERSION` in `lib/archive.mjs`), `migrations` (the ids of new files in `migrations/`), `behaviour_changes` (true when something works differently without the user doing anything).
   - `notes`: `highlights` (one to three lines a user cares about; the Telegram notice shows the first two), `new`, `changed`, `action_needed` (`{ text, setting }`: setting is its path in `settings.json`, such as `schedule.time`; the workspace opens the settings dialog there), `changed_defaults` (`{ setting, default, text }`: the user's own value is kept, and they can accept the new one). `notes_ru` is optional, key by key, English fills the rest.
   - `media`: `{ path, alt }` for screenshots in the repo (`docs/screenshots/...`).
   - Plain words, no em dashes. Data changes follow expand, then contract (`DEVELOPMENT.md`).
3. **Changelog.** `node tools/changelog.mjs` rewrites `CHANGELOG.md`. Commit both.
4. **Tests.** `npm test` passes on Linux and Windows (`test/release.test.mjs` fails when the version has no valid entry or the changelog is stale). `node cli.mjs doctor` runs on the example profile.
5. **Tag.** On `main`, after the pull request is merged:

   ```bash
   git tag -a v0.2.0 -m "CometScout 0.2.0"      # git tag -s with a signing key
   git push origin v0.2.0
   ```

6. **Source zip sha256.** The update downloads GitHub's source zip of the tag and refuses it unless its sha256 matches the one in the release notes:

   ```bash
   curl -fsSL -o cometscout-0.2.0.zip https://github.com/Dreamkeeper/cometscout/archive/refs/tags/v0.2.0.zip
   sha256sum cometscout-0.2.0.zip
   ```

7. **GitHub release** with the generated text (its last lines carry the sha256, `Needs Node` and `Behaviour changes`, which the update check reads):

   ```bash
   node tools/changelog.mjs --release 0.2.0 --sha256 <hash> > notes.md
   gh release create v0.2.0 --title "CometScout 0.2.0" --notes-file notes.md          # add --prerelease for v0.3.0-beta.1
   ```

8. **Check.** On a test install, `node cli.mjs update --check` names the new version; `node cli.mjs update` installs it and `node cli.mjs rollback` goes back.

## When something is wrong

- Wrong notes: edit the GitHub release text (keep the three last lines). Installs that already cached the old text read the new one at their next check.
- A broken release: publish a fixed `vX.Y.Z+1`. Do not move or delete a tag that installs may have downloaded; an install that failed its checks has rolled back by itself and can skip the version (`node cli.mjs update --skip v0.2.0`).
- If GitHub ever serves a different zip for the same tag, updates to it are refused (the sha256 no longer matches). Put the new hash in the release text.
