# 10: Workspace probe, the "Today" screen (M5a)

## Why
jobpilot is moving from Claude Code sessions and Telegram messages to a web workspace: a PWA that is fullscreen and dense on the desktop, installable on the phone, and opens as a Telegram Mini App (later milestones). This task builds the first screen only, as a probe: the maintainer uses it daily for a week on real data before the rest is built. The question the probe answers: is a no-build Preact + htm UI good enough for the pack review, the screen where attention is highest?

The daily chain this screen serves: see today's picks, judge each one (decode, job text, history), review its application pack (CV PDF, form answers, cover letter, flags), then mark it applied, skipped (with a reason) or later.

Read `DEVELOPMENT.md` first. No em dashes in user-facing text. Synthetic data only in tests and fixtures. Every change gets a test.

## Stack (maintainer decision)
- Server: `node:http`, no new runtime dependency for the server.
- Web client: Preact + htm, **no build step**. Add `preact` and `htm` to `package.json` dependencies (pinned exact versions, installed by `npm install` from upstream, never copied into the repo). The server serves `node_modules/preact/dist/*.module.js`, `node_modules/preact/hooks/dist/*.module.js` and `node_modules/htm/dist/htm.module.js` read-only under `/vendor/`, and `web/index.html` maps them with an import map (`preact`, `preact/hooks`, `htm`). No CDN.
- `web/` holds `index.html`, `app.js` (entry), components as ES modules, `styles.css`. Pure logic (filtering, formatting, keyboard map, API client) lives in modules with no DOM access, so `node --test` can test it.
- `doctor` checks that preact and htm resolve from `node_modules` when the workspace is used.

## `cli.mjs serve [--port 8787] [--host 127.0.0.1]`
- Binds to loopback by default. A non-loopback `--host` is refused until sign-in exists (M5b), unless `--unsafe-no-auth` is given, which prints a warning on every start.
- Rejects any request whose `Host` header is not the bound host and port (DNS rebinding). Writes (POST) require the header `X-Jobpilot: 1` (a cross-site form cannot send it). JSON only on the API; no data in URLs beyond the queue file name.
- Static: `/` -> `web/index.html`, `/web/*`, `/vendor/*` (only the three files above). Pack files: `/files/packs/<pack dir>/<file>`, resolved inside `DIRS.packs` only (reject `..`, absolute paths, symlinks out of the folder), `Content-Type` by extension (pdf, docx, md, json).

## API
- `GET /api/today` -> `{ date, picks: [...], pool: [...] }`. `picks`: the jobs in `data/state/picks.json` whose `last` is the latest date there (today's picks, as the evening run chose them; no network calls, no new picks computed). `pool`: every apply-worthy decode in the picks window that is not closed for picks (reuse `buildPicks`' pool and closed-role logic without `linkAlive`; export what is needed from `decoder/decoder.mjs`). Each item: `{ file, company, role, location, source, url, verdict, apply_priority, band, decoded_on, shown, application: { status, updated } | null, pack: <pack dir> | null, later_until }`.
- `GET /api/job?file=<queue file>` -> front matter, job text (without the decode block), the parsed decode (`parseResult`), `history(company)` lines, the application entry. The file must exist in `decoded/` or `rejected/`; anything else is 404.
- `GET /api/pack?file=<queue file>` -> the newest pack folder for that job (from `packs.json`, else by folder name), with `answers` (answers.md text), `pack` (pack.json: flags, lint, positioning, answers, cover letter mode) and `files` (names + URLs). 404 when no pack exists.
- `POST /api/status` `{ file, status, note? }`: the same code path as `cli.mjs status`. Move the body of `setStatus` into `lib/applications.mjs` (one function used by the CLI and the server, same events, same `updated`, same refusal on a broken applications.json) and keep the CLI's output unchanged.
- `POST /api/later` `{ file, days }` (1 to 7): appends an event `{ date, type: "later", until, source: "workspace" }` without changing the status; `/api/today` returns `later_until` and the UI hides the job until then.
- Skip reasons: the UI offers a short list (too senior, too junior, wrong domain, location or visa, language, company, already in contact, other) and sends `status: "skipped"` with the reason as the note. These notes feed a later "wrong pick: why?" settings suggestion.

## The screen
- **Desktop (>= 1100 px): three panes.** Left: today's picks first, then the pool, grouped by verdict, with a search box and filters (source, verdict, has pack, hide later). Middle: the job: company, role, location, source, band, verdict chip and priority, action line, rationale, fit signals, gaps, hold reason, fact flags, history, then the job text (collapsible). Right: the pack: CV PDF preview (`<iframe>` of the PDF), "Check before sending" flags and lint, form answers each with a copy button, the cover letter (copy or file), file links, the apply URL.
- **Phone: one column** with tabs Job / Pack and a fixed action bar.
- **Actions**: Applied, Skip (reason), Later (1, 3, 7 days), Open job link. After an action the next job opens. Keyboard on desktop: j/k next/previous, a applied, s skip, l later, o open link, / search, ? help.
- Light and dark from `prefers-color-scheme`, colours as CSS variables (the Telegram theme maps onto them later). Labels through the existing locale tables (`settings.locale`, en and ru): serve them at `/api/labels`.
- Loading and empty states ("no picks today; N open in the pool"), and an error banner when the API fails.

## Tests
- API handlers with a temp data dir: synthetic decoded files, picks.json, applications.json, a pack folder with a tiny valid PDF fixture: today/pool contents, closed roles excluded, `later_until`, job and pack payloads, 404s, path traversal attempts on `/files/packs/` (encoded `..`, absolute, backslashes on Windows), Host header check, POST without `X-Jobpilot` refused, `/api/status` writes exactly what `cli.mjs status` writes for the same input (compare files), broken applications.json refused.
- `cli.mjs serve` smoke test: start on a free port, `GET /` returns the HTML with the import map, every module URL it references returns 200 with a JavaScript content type, stop.
- Web logic modules: filtering and grouping, keyboard map, label lookup, formatting (dates, verdict names).
- Must pass on Linux and Windows.

## Done when
`npm test` passes; `node cli.mjs serve` shows the screen against the example profile's data; README section "Workspace (preview)" (how to start it, that it binds to localhost, what each pane shows, the keyboard keys); `settings.example.json` unchanged unless a setting is needed; ROADMAP row for M5a. PR description lists what was built, what was not, open questions, and screenshots (desktop and phone width) taken against the example data.
