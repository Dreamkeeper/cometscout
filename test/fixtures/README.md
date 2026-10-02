# Test fixtures

Everything here is **synthetic**: companies, people, emails, vacancies and texts are invented. Only the structure
mirrors the real APIs and pages as of 2026-09 (field names, nesting, HTML markers), so parsers can be tested
without network access and without anyone's personal data.

| Folder | Mirrors |
|---|---|
| `rtj/` | RealtimeJobs `POST /api/jobs/search` items (`position` + `employer`); `_expect` notes the intended gate result |
| `hh/` | hh.ru subscription email HTML and public vacancy pages as of 2026-10 (`data-qa` markers, the archive label inside the title, the page state as HTML-escaped JSON); `expected.json` |
| `hirify/` | Hirify `/api/vacancies` list and detail responses, `/auth/user`; `expected.json`. `vacancies-real-page-1.json`, `vacancy-9200*.json` and `expected-real.json` follow shapes seen in production (slugs that start with the id, `allowed_locations` such as `anywhere`, `europe`, `european_union`, `united_kingdom`, fields masked as `%...%`); `vacancies-masked-percent.json` is a page seen without a working session; `auth-user-login-page.html` is the login page a dead session gets instead of JSON |
| `linkedin/` | LinkedIn job-alert email (text part) and the public guest job page |
| `openclaw/` | A `synthesis-queue.json` with page titles in the formats seen from ATSs and job aggregators |
| `fetch-detail/` | Canned Greenhouse, Ashby, Lever, Workable and Recruitee API responses and job-posting pages (with and without JSON-LD), for `lib/fetch-detail.mjs` |
| `gmail/` | Application outcome emails with the expected event type |
| `lint/` | A WordprocessingML `document.xml` (bold heading, long summary, a bullet with entities split over runs, a tab, empty paragraphs), lint and fact rules, and a CV library in which one bullet breaks a rule on purpose |
| `career-ops/` | career-ops `data/pipeline.md` and `data/scan-history.tsv` in the shapes its `scan.mjs` writes (every row shape, labeled segments, skipped and expired rows, the 12-column history); canned Ashby, Greenhouse and Lever answers and a plain job page for the links it lists; `expected.json` |

Do not replace these with real data. If a real format changes, update the synthetic sample to match the new structure.
