# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability** (or go straight to https://github.com/Dreamkeeper/cometscout/security/advisories/new). Do not open a public issue, pull request or discussion for it.

A useful report says what is affected (file, command or endpoint, and the CometScout version), how to reproduce it, and what an attacker gains. Use synthetic data only: never send real CVs, job-search records, tokens or the contents of a `.env` file.

You get an answer in the advisory. When a fix is ready, it ships in a release and the advisory is published with it, crediting you unless you ask not to be named.

## Supported versions

Only the latest release ([Releases](https://github.com/Dreamkeeper/cometscout/releases)) gets security fixes. `node cli.mjs update` installs it.

## In scope

- **The installer:** `deploy/install.sh` and the module installers in `deploy/modules/` (they run with the user's rights, `install.sh` also with sudo for packages).
- **The update and rollback:** the update check, the download and its sha256 check, the side-by-side install, migrations, `node cli.mjs rollback` (`lib/update.mjs`, `lib/update-cli.mjs`, `lib/layout.mjs`, `lib/release.mjs`, `lib/migrate.mjs`).
- **The workspace:** `node cli.mjs serve` and its HTTP API, including the one-time `/secrets` page (`lib/server.mjs`, `lib/workspace.mjs`, `lib/secrets-form.mjs`, `web/`).
- **The MCP server:** `node cli.mjs mcp`, its scopes, tools and the writes they make (`lib/mcp.mjs`, `lib/mcp-tools.mjs`).
- **The transcription module's downloads:** the Python packages it installs, the GigaAM archive, and the speech and speaker models it fetches (`lib/transcribe.mjs`, `lib/transcribe-speakers.mjs`, `deploy/modules/transcribe/`).

Also welcome: anything that leaks a secret from `.env`, a backup or an export, or that lets a job text, an email or a Telegram message run code or change settings.

## Out of scope

- Third-party projects CometScout installs or calls (Claude Code, Codex, the interview coach, job boards, Gmail, Telegram): report those to their own maintainers. How CometScout pins, checks and runs them is in scope.
- A workspace started with `--unsafe-no-auth` on a network address: that flag exists for a trusted network only and says so.
- Problems that need an attacker who can already write the user's `settings.json`, `.env` or code folder.
