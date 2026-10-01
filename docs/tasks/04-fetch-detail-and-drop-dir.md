# 04: Full-text fetcher and external producer intake

## Why
Other tools find jobs too (an OpenClaw agent searching the web, a career-ops scan, a script someone writes). jobpilot should accept their finds, fetch the full job text from the ATS, recover the company from page titles, and skip search-result pages.

## Build `lib/fetch-detail.mjs`
`fetchDetail(url, { fetch = globalThis.fetch } = {})` → `{ via, title, location, text, companyHint } | { via, unavailable }`:
- Greenhouse `(job-boards|boards)(.eu)?.greenhouse.io/<board>/jobs/<id>` → `boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>`
- Ashby `jobs.ashbyhq.com/<org>/<uuid>` → `api.ashbyhq.com/posting-api/job-board/<org>?includeCompensation=true`, find the id; missing = unavailable
- Lever `jobs(.eu)?.lever.co/<co>/<uuid>` → `api(.eu)?.lever.co/v0/postings/<co>/<uuid>`
- Workable `apply.workable.com/<acct>/j/<code>` → `apply.workable.com/api/v2/accounts/<acct>/jobs/<code>`
- Recruitee `<co>.recruitee.com/o/<slug>` → `<co>.recruitee.com/api/offers/<slug>`
- Otherwise the page: JSON-LD `JobPosting` first, else visible text (over 600 characters).
- HTTP 404/410 → unavailable ("posting gone"). Network error → `{ via: 'error', error }`.

Also export:
- `parseSearchTitle(title, isTitle)` → `{ company, title, location }` for page titles: "Job Application for X at Y" (Greenhouse), "X at Co in City | JobFluent", "X at Co | Y Combinator's Work at a Startup", "Co hiring X • Place | Himalayas", "[Hiring] X @Co" (Remotive), "Co: X" (We Work Remotely), "Co - X" / "X - Co" (Lever/Workable: the half that passes `isTitle` is the title).
- `companyFromUrl(url)`: the board slug for Greenhouse, Lever, Ashby, Workable, Recruitee, title-cased.
- `isListingPage(url, title)`: search/listing pages are lists of jobs, not a job: `jobfluent.com/jobs-<city>/…`, `/jobs/` paths on recruiter sites, Indeed search, LinkedIn search/collections, Glassdoor job lists, and titles like "jobs for/in …", "ofertas de empleo", "vacantes", "job openings".

## Build `sources/drop-dir.mjs`
Settings `sources.drop_dir`: `{ enabled, dir, settle_sec: 60, move_processed_to: "<dir>/processed" }`. Two accepted inputs in `dir`:
1. Job files in jobpilot's own format (front matter `company, role, url, source, …` + body): validate, `writeJob` (dedupe applies), then move the file to `processed/`.
2. `*.queue.json` with `{ candidates: [{ title, url, company?, location?, source_key? }] }` (shape: `test/fixtures/openclaw/synthesis-queue.json`): for each, skip listing pages, `fetchDetail`, company = given or `parseSearchTitle` or `companyHint` or `companyFromUrl`; no company and no text = skip as unidentifiable; unavailable = skip; else `writeJob` with `source: 'drop:<source_key or file name>'`.
Files younger than `settle_sec` are left for the next run (another program may still be writing them). Keep a seen-URL list in `data/state/drop-dir.json`.

## Tests
Inject `fetch` with canned API responses; every `_expect` in `test/fixtures/openclaw/synthesis-queue.json`; listing pages rejected; 404 → unavailable; settle time respected; processed files moved.

## Done when
Tests pass; source registered; README explains how an external tool hands jobs to jobpilot.
