# 05: career-ops source

## Why
[career-ops](https://github.com/career-ops-hq/career-ops) (MIT) scans company boards and keeps a pipeline file. Users running it alongside jobpilot should get its finds decoded and picked by jobpilot without copying them by hand.

## Build `sources/career-ops.mjs`
Settings `sources.career_ops`: `{ enabled, path, include_evaluated: false, max_per_run: 30 }`, where `path` is the career-ops checkout.
- Read `<path>/data/pipeline.md` (format: `test/fixtures/career-ops/pipeline.md`):
  - `- [ ] <url> | <company> | <role>`: a candidate.
  - `- [!] … — SKIP: …`: skip.
  - `- [x] #NNN | <url> | <company> | <role> | <score> | …`: already evaluated by career-ops; include only if `include_evaluated`, with the score in `notes`.
- Read `<path>/data/scan-history.tsv` (`url, first_seen, portal, title, company, status`): rows with status `added` not present in the pipeline are candidates too; `filtered` and others are skipped.
- For each candidate: full text via `fetchDetail` (task 04); unavailable = skip; `writeJob({ company, role, url, source: 'career-ops', text, notes })`. Respect `max_per_run`, fair across companies like `ats-boards`.
- Seen URLs in `data/state/career-ops.json`.
- Never write into the career-ops folder.

## Tests
Fixtures in `test/fixtures/career-ops/`; inject `fetchDetail`. Check `expected.json`, the evaluated-item switch, nothing written in the source folder.

## Done when
Tests pass; registered; `doctor` checks that `path` exists and has `data/pipeline.md`; README section.
