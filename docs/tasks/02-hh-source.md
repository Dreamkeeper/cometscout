# 02: hh.ru alerts source

## Why
Russian-speaking users get hh.ru saved-search ("Вакансии по подписке") and resume-match ("Подходящие вакансии") emails. The email lists vacancies; the full text is on the public vacancy page.

## Build `sources/hh-alerts.mjs`
1. Gmail (reuse `lib/gmail.mjs`, read-only): `from:noreply@hh.ru (subject:"Вакансии по подписке" OR subject:"Подходящие вакансии") after:<epoch>`. Window: since the last successful run plus `overlap_hours` (24), first run `first_run_hours` (72). Alert name = subject with the prefix shortened ("подписка: …", "резюме: …").
2. Vacancy ids: every `hh.ru/vacancy/(\d{6,})` in the HTML part. **Only ever fetch `https://hh.ru/vacancy/<id>`**: emailed links carry login keys (`key=`); never follow, log or store them.
3. Fetch each page sequentially, `delay_ms` (3000, minimum 2000) apart, at most `max_fetch` (40) per run, header `Accept-Language: ru,en;q=0.8`. A single 403 = hidden from logged-out visitors (unavailable, mark seen). Two 403s in a row, or any 429 = throttled: stop the run, do not mark the rest seen.
4. Parse by `data-qa` markers (see `test/fixtures/hh/vacancy-*.html`): `vacancy-title`, `vacancy-company-name`, `vacancy-view-raw-address` or `vacancy-view-location`, `work-formats-text` (strip "Формат работы:"), `vacancy-salary`, `vacancy-experience`, `common-employment-text`; description = HTML from `data-qa="vacancy-description"` up to the first of `skills-element|vacancy-skills|vacancy-address|vacancy-contacts|vacancy-response-link-bottom|bloko-tag-list`, converted with `htmlText`. "В архиве" in the title or `"archived": true` in the page = archived (unavailable). No title or no description = unavailable (do not mark seen if this happens to 3 pages in a row: the layout probably changed).
5. Remote = formats or title say удалённо/удаленно/remote/"полностью удалённая". Build the gates `job`: attendance from formats, countries from the city when it maps to a country (a small Russian/English city→country table in settings or code for major cities), text = title + description, languages `['ru']` when the page is Russian.
6. Source-specific checks before the shared gates (settings `sources.hh_alerts`):
   - `title_include` / `title_exclude` (Russian and English lists, via `matchesAny`);
   - `must_reside_phrases`: for a remote job, a phrase that means the candidate must live in a given country → reject `geo-remote` (example list in `settings.example.json` is empty; document the idea);
   - `abroad_signals`: phrases that suggest working from abroad is fine → flag; none found → flag "confirm working from your country is allowed";
   - `tax_residency_phrases` → flag.
7. `writeJob({ company, role, url: 'https://hh.ru/vacancy/<id>', source: 'hh', location: '<city>; <formats>', salary, text, notes: 'hh alert: <alert names>', extra: { experience, employment, posting_language: 'ru' } })`.
8. State `data/state/hh-alerts.json`: `{ last_run, seen: { id: date } }`; prune seen entries older than 120 days.
9. `--dry-run`, `--ids 123,456` (test specific vacancies without Gmail), `--hours N`.

## Tests
Inject a fake Gmail client and `fetch` that serve `test/fixtures/hh/`. Check every line of `test/fixtures/hh/expected.json`, that no `key=` link is ever requested, the throttling stop, and that `--dry-run` writes nothing.

## Done when
Tests pass; `cli.mjs` registers `hh_alerts`; `doctor` checks Gmail credentials when it is enabled; `settings.example.json` has a disabled block; README lists the source.
