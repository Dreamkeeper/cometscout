# 09: Tracker export, source scorecard, health ping, failure alerts, Russian labels

## Why
Four small pieces the original pipeline runs every day: an export to the Job Pipeline Tracker app, a monthly "which source earns its price" table, a health ping so a dead timer is noticed, and Russian labels for users who read their digest in Russian.

Read `DEVELOPMENT.md` first. Plain Node 20, no new dependencies, synthetic data only, no em dashes in user-facing text. Every change gets a test. These pieces are independent: separate commits are welcome.

## 1. `cli.mjs tracker-export [--out <file>] [--dry-run]`
Writes the import file of job-pipeline-tracker (github.com/Dreamkeeper/job-pipeline-tracker), which re-imports whenever `exportedAt` changes:
```json
{ "app": "job-pipeline-tracker", "version": 1, "exportedAt": "2026-10-02T09:00:00.000Z", "contentHash": "16 hex chars",
  "applications": [ { "company": "Acme", "role": "Product Manager", "stage": "Interview", "furthestStage": "Interview",
    "dateApplied": "2026-09-20", "lastActivity": "2026-10-01", "notes": "Last update 2026-10-01", "source": "linkedin", "link": "https://..." } ] }
```
- Rows: every `applications.json` entry that is an application (status other than `skipped`, or an `applied` event). Skipped roles and roles never applied to are not exported.
- `stage`: one of Applied, Screen, Interview, Offer, Rejected, Withdrawn, from the status (`withdrawn` and `closed` map to Withdrawn). `furthestStage`: one of Applied, Screen, Interview, Offer: the furthest stage the events and status reached (a rejection after an interview keeps Interview).
- `dateApplied`: the first `applied` event, else `applied` date field, else `updated`. `lastActivity`: the latest event or update date. `notes`: "Rejected <date>", "Closed <date>" or "Last update <date>". `source` from the queue file's front matter when the entry is keyed by one; `link` from its `url`.
- Overrides: optional `data/state/tracker-overrides.json` `{ "overrides": [ { "company": "...", "role": "substring", "drop": true } | { "company": "...", "stage": "Interview", ... } ] }`, matched with `companyMatch` when task 07 has landed (else normalised equality); an override that matches nothing is reported.
- `contentHash`: sha256 of the applications array, first 16 hex chars. The file is rewritten (atomically, tmp + rename) only when the hash changes; output says `unchanged (N applications: Applied 3, ...)` or `wrote <file>`.
- Validate every row before writing (stages in the lists, dates `YYYY-MM-DD`); an invalid row stops the export with the row shown.
- Settings `tracker_export: { "enabled": false, "out": "data/tracker/pipeline.json" }`; when enabled, `cli.mjs run` runs it at the end (failures logged, never fatal).

## 2. `cli.mjs sources-report [--send]`: which source earns its price
- **Sightings.** `writeJob` appends one line per call to `data/state/sightings.jsonl`: `{ date, source, company, role, url, result: "written" | "duplicate", where }` (also for duplicates, which is the point: a job found by two sources is not "only here"). Keep the file to 120 days (trim on write, at most once a day).
- **Table** (window 30 days, `sources_report.window_days`): per source: queued; worth applying (decodes with strong-fit or investable-stretch); only here (worth-applying jobs no other source sighted, same `companyMatch` company and `roleOverlap >= 0.5` within 7 days either side; plain normalised equality until task 07 lands); picks shown (from `data/state/picks.json`); applied and past application stage (screen, interview, offer) all-time from `applications.json` via the queue file's source; price per month and price per only-here role.
- Prices from settings: `sources_report.prices: { "rtj": { "price_month": 10, "currency": "USD", "renews": "2026-12-01", "decision": "under review" }, "some-premium-plan": { "feed": false, "price_month": 20, "currency": "EUR" } }`. `feed: false` entries are listed under the table as "not a job feed".
- Writes `data/reports/source-scorecard.md`, prints it. `--send` sends a short Telegram version (one line per source) when today is the 1st or 7 days or less before any `renews` date, once per trigger (state in `data/state/sources-report.json`). `cli.mjs run` calls it with `--send` after the digest when `sources_report.enabled`.

## 3. Health ping
`health.ping_url` (healthchecks.io style): after `cli.mjs run`, GET `<url>` on exit 0, `<url>/<exit code>` otherwise, 10 s timeout, never fatal, never logged with the URL (it is a secret). `doctor` shows whether it is set.

## 4. Failure alert unit
`deploy/`: a `jobpilot-failure@.service` template that runs `node cli.mjs notify "jobpilot: %i failed, see journalctl -u %i"`; `install.sh` adds `OnFailure=jobpilot-failure@%n.service` to the run unit. New `cli.mjs notify <text>` sends one Telegram message through `lib/telegram.mjs` (exit 0 when delivery is off, with a log line).

## 5. `settings.locale: "ru"`
`lib/i18n.mjs` with an `en` and a `ru` table for every user-facing label the digest, picks block, verdict labels, pack Telegram headings and the scorecard's Telegram text use. Default `en`. Model output is not translated. A test renders the digest and picks text with `ru` and checks no English label from the table is left.

## Tests
One test file per piece. Temp data dirs, synthetic applications and queue files, injected fetch for the ping, injected Telegram send.

## Done when
`npm test` passes; `doctor` runs on the example profile; README sections for each piece; `settings.example.json` blocks (all disabled); ROADMAP row updated. PR description lists what was built, what was not, and open questions.
