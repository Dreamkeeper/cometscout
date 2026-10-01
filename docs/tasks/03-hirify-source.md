# 03: Hirify source

## Why
Hirify aggregates remote and relocation jobs for Russian-speaking candidates, with structured fields (work format, allowed and excluded locations, language requirements). Its API needs the user's logged-in session cookie.

## Build `sources/hirify.mjs`
- API base `https://api.hirify.me`. Endpoints used: `GET /auth/user` (session check), `GET /api/vacancies?<filter query>&page=N` (list, items in `data`), `GET /api/vacancies/<id>` (detail in `data`, or the object itself). Shapes: `test/fixtures/hirify/`.
- Auth: `Cookie` header from `.env` `HIRIFY_COOKIE` (the user pastes it there; never print it). Save `set-cookie` updates to `data/state/hirify-cookies.json` (mode 600) and prefer them on the next run.
- Session check before fetching: `/auth/user` must return a user (`id` or `data`). Then fetch page 1 of the first filter: if it has 5 or more items and every `company_title` is masked (only `*`, `•` or empty), the session is not taking effect: print "refresh HIRIFY_COOKIE" and exit 3. A 401/403 also exits 3. Exit 3 must make the run report a failure (health alerts pick it up).
- Settings `sources.hirify`: `enabled`, `cookie_env` (`HIRIFY_COOKIE`), `filters: [{ name, query }]` (query = the query string of a saved filter on the site), `max_pages_per_filter` (3), `max_age_days` (14, by `created_at`/`reopened_at`), `delay_ms` (1500), `title_exclude`.
- Per vacancy (detail call): skip `is_scam`/`is_potential_scam` (gate `scam`), `is_archived` (unavailable). A company that stays masked even with a working session → keep as "Confidential (Hirify)" with a flag.
- Build the gates `job`: `languages: [vacancy_language]`, `required_languages` from `language_requirements[{language, level}]`, attendance from `work_format`, countries from `office_locations` (country names → ISO codes), `allowed_regions` from `allowed_locations`, `excluded_countries` from `excluded_locations`, industries from `tags[].name` plus a trailing "(Domain)" in the title. Remote with `allowed_locations` empty = worldwide.
- `writeJob({ company, role: title, url: apply_url or 'https://hirify.me/jobs/<id>-<slug>', source: 'hirify', location, salary: 'from-to CUR', text: clear_text or htmlText(text), extra: { hirify_url, english_level, posting_language, visa: visa_sponsorship } })`.
- State `data/state/hirify.json`: seen ids with first-seen date and status; prune after 120 days.

## Tests
Inject `fetch` serving `test/fixtures/hirify/`. Check `expected.json`, the masked-session exit, cookie refresh persisted, nothing printed that contains the cookie.

## Done when
Tests pass; registered in `cli.mjs`; `doctor` checks the cookie variable; disabled block in `settings.example.json`; README documents how to copy the cookie from the browser into `.env` (and that it expires).
