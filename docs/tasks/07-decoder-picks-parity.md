# 07: Company aliases, dedupe against applications, decoder history and fact guard, picks parity

## Why
The original pipeline this repository is being brought level with does four things jobpilot does not yet do: it knows that two company names are one employer, it never re-queues a role close to one the user already acted on, it keeps "I never did X" in a rationale from tripping a fact rule, and its daily picks never show a role the user is already in process for. Each gap has cost a real application day (a role picked again after the recruiter had replied; a role at a company listed under its parent's name picked twice).

Read `DEVELOPMENT.md` first. Plain Node 20, no new dependencies, synthetic data only in tests and fixtures, no em dashes in user-facing text. Every change gets a test that fails on the current code.

## 1. `lib/companies.mjs`: alias families and role overlap (shared)
- Move `aliasFamilies()` and `companyMatch()` out of `sources/outcomes.mjs` into `lib/companies.mjs`; outcomes imports them (no behaviour change there, its tests must still pass). Settings key stays `queue.aliases`: `[["Acme Robotics", "Acme"], ["Northwind Labs", "Northwind", "NWL Group"]]`.
- `familyOf(name)`: the normalised names of the family whose any alias occurs in `norm(name)` as whole words (not a substring: alias "ola" must not match "Motorola"); aliases shorter than 3 characters only match the whole name. Without a family: `[norm(name)]`.
- `companyMatch(a, b)`: any member of `familyOf(a)` equals, or (both at least 4 characters) is contained as whole words in, a member of `familyOf(b)`. Empty or "unknown" never matches anything.
- `roleWords(role)`: normalised words longer than 2 characters minus `ROLE_STOPWORDS` (move it from outcomes too). `roleOverlap(a, b)`: shared words / the smaller set; 0 when either set is empty.

## 2. Dedupe against the user's applications (`lib/queue.mjs`, `alreadyQueued`)
Maintainer decision: fuzzy matching applies against `data/state/applications.json` only; against plain decodes the existing exact-title rule stays (a second, different opening at a company the user only decoded must still reach them).
- After the URL check and the exact-title check, look at every application entry (any status: applied, screen, interview, offer, rejected, closed, skipped, withdrawn): when `companyMatch(entry.company, company)` and `roleOverlap(entry.role, role) >= 0.5`, the job is a duplicate. Reason: `already in applications: <company>: <role> (<status>)`.
- Not applied when `byTitle` is false (placeholder company such as "Confidential (Hirify)") or the company is empty/"unknown".
- Example that must be a duplicate: applied to `Acme: Senior PM, Robotics`, new job `Acme Robotics: Product Manager, Robotics` with the alias family above. Must not be: same company, `Hardware Product Manager` vs an application for `Data Analyst`.
- Read applications once per process (like the index) and refresh it when `cli.mjs applied/status` changes it in the same process (it does not today; a module-level cache with an mtime check is enough).

## 3. The "screen" status
Imported histories and outcome emails have a recruiter screen stage. Add `screen` to `STATUSES` in `cli.mjs` (between applied and interview), to the picks closed set, and to the outcomes status ranking (a screen never downgrades an interview). README: list it where statuses are listed.

## 4. Decoder history (`decoder/decoder.mjs`, `history()`)
- Match the company with `companyMatch` instead of `norm(a) === norm(b)`, for application entries and past decodes.
- Export it as `history(company, { before, excludeFile } = {})`: `before` (YYYY-MM-DD) keeps only applications updated and events dated before that day and decodes made before it; `excludeFile` drops the job's own application entry and decode. The evals (task M3) use this to stop a job's own outcome leaking into its decode. Unit-test both.
- An application whose events are all after `before` but whose `updated` is earlier still shows only the events before the cutoff.

## 5. Fact flags with a negation guard (`factFlags`)
Rules in `profile/fact-rules.json` may carry `"guard": true`. Port this behaviour:
- Text checked: rationale, action, hold_reason, fit_signals and gaps, joined with " \n ".
- Patterns are compiled with flags `gi`; each rule reports at most its first counted match, with `excerpt` (the matched text, max 80 chars) next to `id` and `why`.
- For a guarded rule, a match is ignored when the 50 characters before it contain a negation word (`never|not|no|nor|without|wasn't|isn't`, whole words) or the 12 characters after it start with an employer word (`^\s*(hire|mandate|role|req|seat|:)`). So "was never the first PM" and "the first PM hire" do not flag; "as the first PM there" does.
- `resultBlock` keeps printing the ids; the excerpt goes to the decoded hook payload.

## 6. `decoder.prompt_file`
Optional setting: a prompt file (absolute, or relative to the profile directory) used instead of `decoder/prompt.md`, with the same `{{NAME}}` and `{{PROFILE}}` placeholders. `doctor` reports which prompt is in use and fails when the file is missing.

## 7. Picks parity (`buildPicks`)
- **Closed roles.** A pool job is closed when its own file is an application key, or any application entry with a status in the closed set (applied, screen, interview, offer, rejected, withdrawn, closed, skipped) or with any `events[]` matches it: `companyMatch` on the company and either `roleOverlap >= 0.5` or one side's role words are empty (the company matched and the role is unreadable: treat as the same process). This replaces the exact `company|role` string match.
- **No company, no pick.** A job whose company is empty or "unknown" is never a pick (listing-page artefacts).
- **Band.** When the front matter has `band` 1 to 4, add it to the score (unknown band: 2.5), as the original does: lower is better.
- **Shape.** `shapeRank`: remote words also include `remoto`, `anywhere`, `worldwide`. New optional `picks.shape_bonus`: `[{ "location_regex": "barcelona|spain", "rank": 1 }]`; the first matching entry sets the rank of a job that is not fully remote (fully remote stays 0; remote with an office day 1.5; on-site 2).
- **On-site exclusion.** New optional `picks.exclude_onsite_location_regex`: excludes a job when its location matches and it is not fully remote (a fully remote job from that country stays). `exclude_location_regex` keeps its current meaning.
- **Archived links** (`linkAlive`): an hh.ru vacancy page is dead when it has `data-qa="vacancy-title-archived-text"`, the text "В архиве с", or `archived(&#34;|&quot;|")\s*:\s*true`; a Hirify job page (`hirify.me/jobs/`) is dead with "Эта вакансия в архиве" or "This vacancy is archived". Network errors and 403/429 still count as alive. Inject `fetch` in tests.

## Tests
New `test/companies.test.mjs`, `test/picks.test.mjs` (build a temp data dir with decoded files and an applications.json; inject fetch), additions to `test/queue.test.mjs` and a decoder history/fact-flag test (export what you need; do not call a model). Synthetic companies only.

## Done when
`npm test` passes; `node cli.mjs doctor` runs on the example profile; README updated (aliases, the dedupe rule, screen, prompt_file, the new picks settings, the fact-rule guard); `settings.example.json` shows the new optional keys; ROADMAP row updated. PR description lists what was built, what was not, and open questions.
