# Test fixtures

Everything here is **synthetic**: companies, people, emails, vacancies and texts are invented. Only the structure
mirrors the real APIs and pages as of 2026-09 (field names, nesting, HTML markers), so parsers can be tested
without network access and without anyone's personal data.

| Folder | Mirrors |
|---|---|
| `rtj/` | RealtimeJobs `POST /api/jobs/search` items (`position` + `employer`); `_expect` notes the intended gate result |
| `hh/` | hh.ru subscription email HTML and public vacancy pages (`data-qa` markers); `expected.json` |
| `hirify/` | Hirify `/api/vacancies` list and detail responses, `/auth/user`; `expected.json` |
| `linkedin/` | LinkedIn job-alert email (text part) and the public guest job page |
| `openclaw/` | A `synthesis-queue.json` with page titles in the formats seen from ATSs and job aggregators |
| `gmail/` | Application outcome emails with the expected event type |
| `career-ops/` | career-ops `data/pipeline.md` and `data/scan-history.tsv` |

Do not replace these with real data. If a real format changes, update the synthetic sample to match the new structure.
