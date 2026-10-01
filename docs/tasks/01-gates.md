# 01: Shared gates module

## Why
Each source filters jobs its own way today (title words, a location regex, a headcount cap). A mature setup needs the same hard rules everywhere, decided before any model call: language, work authorization, where on-site work is possible, remote scope, sponsorship, company size, excluded companies and industries. Rules must come from settings, never from code.

## Build
`lib/gates.mjs` exporting `checkGates(job, gates = SETTINGS.gates)` → `{ decision: 'pass' | 'reject' | 'demote', gate, reason, flags: [] }`.

`job` is a normalised description each source builds from its native fields (missing fields are `null`/empty and must never cause a reject on their own):

```js
{ company, title, text,                      // text = description, used for phrase checks
  languages: ['en'],                         // posting language(s), ISO 639-1
  required_languages: [{ lang: 'de', level: 'c1' }],
  attendance: ['remote' | 'hybrid' | 'office'],
  countries: ['ES'],                         // ISO 3166 alpha-2 of on-site / office locations
  locations: [{ country: 'ES', attendance: ['office'] }],   // optional per-location pairs; without them every country pairs with attendance
  remote_scope: 'worldwide' | 'geo_restricted' | 'none' | null,
  allowed_regions: ['Europe', 'ES'],         // free text or ISO codes
  excluded_countries: ['ES'],
  required_citizenships: [], forbidden_citizenships: ['RU'],
  sponsorship: 'AVAILABLE' | 'NOT_AVAILABLE' | 'AMBIGUOUS' | 'NOT_MENTIONED' | null,
  mandatory: [{ class: 'LEGAL_AUTHORIZATION', text: '...' }],
  headcount: { min, max } | null, industries: ['IoT'] }
```

Settings (`settings.gates`, every key optional; absent = no check):

```json
"gates": {
  "user": { "citizenships": ["XX"], "work_authorization": ["ES"] },
  "languages": ["en"],
  "onsite_countries": ["ES", "DE", "NL", "FR"],
  "remote": { "accept_worldwide": true, "accept_regions": ["Europe", "EU", "EMEA"] },   // shipped example: ["Europe*", "EU", "EEA", "EMEA"]
  "sponsorship_refusal_phrases": ["without sponsorship", "no visa sponsorship", "must be authorized to work in"],
  "must_reside_phrases": [],
  "headcount": { "demote_over": 500, "reject_over": null, "reject_keywords_over": { "min": 500, "keywords": ["smart home"] }, "demote_unless": ["remote_worldwide", "remote_region", "sponsorship"] },
  "companies": { "exclude": [], "agencies": [] },
  "industries": { "exclude": [] }
}
```

Order of checks and gate names (first reject wins; flags accumulate):
1. `company` excluded (whole-word, case-insensitive via `matchesAny`), or listed as an agency → reject `company`.
2. `industry`: any of `industries` or the company/title text matches `industries.exclude` → reject `industry`.
3. `language`: posting languages present and none in `gates.languages` → reject; a `required_languages` entry not in `gates.languages` at level B2 or higher (b2, c1, c2, native, fluent) → reject; lower levels → flag.
4. `legal`: any of the user's citizenships in `forbidden_citizenships` → reject; `required_citizenships` non-empty and not matching → reject; a `LEGAL_AUTHORIZATION` mandatory line or a `sponsorship_refusal_phrases` hit when the job is on-site/hybrid outside `user.work_authorization` → reject; `sponsorship: NOT_AVAILABLE` with on-site outside `work_authorization` → reject; when the source says `sponsorship: AVAILABLE` these are a flag, not a reject, even if the text says "must be authorized to work in"; jobs that are not on-site only (remote, or attendance unknown) only get a flag for these. Language codes compare by primary subtag (`en-US` is `en`).
5. `geo`: on-site/hybrid only (no remote) and no country in `onsite_countries` → reject; `excluded_countries` contains a `work_authorization` country → reject (`geo-remote`).
6. `remote`: remote with scope `geo_restricted` → pass if any allowed region matches `remote.accept_regions` or names (in words or ISO codes) a `work_authorization`/`onsite_countries` country; else, if the job has an office or hybrid location (that location's own attendance) in one of those countries → pass with a flag; else reject `geo-remote`. No regions listed, or no `accept_regions` in settings → flag only. `worldwide` → pass if `accept_worldwide`. A `must_reside_phrases` hit in a remote job's text → reject `geo-remote` (e.g. phrases meaning "must live in country X").
7. `headcount`: `min > reject_over` → reject; `reject_keywords_over` when `min >= its min` and a keyword appears in industries/title → reject; `min > demote_over` → demote unless one of `demote_unless` holds (remote worldwide, remote region accepted, sponsorship AVAILABLE).

`demote` means: do not queue now; the source logs it under "demoted" (the user can lower the bar later).

## Wire it in
- `sources/rtj.mjs`: build `job` from the RTJ item (see `test/fixtures/rtj/positions.json`; map `position.languages`, `locations[].country/attendance`, `remote_scope`, `allowed_regions`, citizenship arrays, `visa_sponsorship_availability`, `objective_criteria` where `is_mandatory`, `employer.headcount`, `employer.industries`), call `checkGates`, skip rejects and demotes with a count per gate in the log line.
- `sources/ats-boards.mjs` and `sources/linkedin-alerts.mjs`: build what they can (company, title, text, countries from location text when obvious) and call it too.
- `cli.mjs doctor`: one line summarising which gates are active; warn on unknown keys under `gates`.
- `settings.example.json`: a `gates` block with neutral example values; README section.

## Tests (`test/gates.test.mjs`)
- Every `_expect` in `test/fixtures/rtj/positions.json` with a sample `gates` config where the user has citizenship `RU`, work authorization `ES`, on-site countries ES/DE/NL/FR, languages en/ru, demote over 500.
- Unit cases per gate, including Cyrillic text and missing fields (must pass, not reject).

## Done when
Tests pass, the RTJ fixture expectations hold, no source behaves differently when `gates` is absent.
