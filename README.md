# jobpilot

**По-русски:** установка на Debian шаг за шагом в [README-rus.md](README-rus.md).

A self-hosted job search pipeline that runs every evening on your own server and ends with something you can act on: **up to two roles worth applying to, each with a CV tailored from your own checked wording and draft answers for its application form.**

It is built by a product manager for his own search (seven applications in four days once it was running) and uses the Claude or ChatGPT subscription you already have. Your data never leaves your server except for the model calls.

## How it works

```
sources  ─►  inbox  ─►  decode  ─►  picks  ─►  application pack  ─►  Telegram
(job boards,          (your profile,    (best 2 a day,     (tailored CV PDF,
 RealtimeJobs, ...)    hard gates,       dead links and     cover letter if the
                       fit verdict)      applied roles      form asks, drafted
                                         skipped)           form answers)
```

- **Sources** (all optional): public Greenhouse, Ashby and Lever boards of your target companies (no login); RealtimeJobs API (your token); LinkedIn and hh.ru job-alert emails, read from your Gmail with read-only access, each job's full text taken from the public job page. More sources (Hirify) are being ported.
- **Decode:** each job is judged against `profile/profile.md`: your experience, what you want, location and work permit, hard gates, and scope guards (what you must never claim). Verdicts: strong fit, investable stretch, long shot (with the reason it was held), weak fit, gate.
- **Picks:** the best two open roles of the last two weeks, different companies, remote first, links checked, roles you already applied to excluded.
- **Application pack:** the CV is assembled only from `profile/cv-library.json`, text you approved. The model selects and orders; it may write only the tagline and summary, and both are checked against your fact rules. The application form is read automatically for Ashby, Greenhouse and Lever, and every non-personal question gets a draft in your voice (`profile/voice.md`). Sections and company blocks are kept whole across the page break whenever two pages have room (the pack says so when they do not). A "check before sending" list names every decision that is yours (salary, location, gaps).

## Quick start

On a Debian or Ubuntu VPS, as your normal user:

```bash
git clone https://github.com/Dreamkeeper/jobpilot.git && cd jobpilot
bash deploy/install.sh
```

Then open the folder in **Claude Code** or **Codex** and say **"set me up"**. The agent follows `AGENTS.md`: it interviews you for the profile, turns your CV into the library (you approve every line), connects a first source, and shows you a real decoded job and its tailored CV in the same sitting. Telegram delivery and the daily timer come after.

Try it before onboarding: with no `profile/`, jobpilot runs on the fictional example profile in `profile.example/`.

## Commands

```bash
node cli.mjs doctor                       # what is set up, what is missing
node cli.mjs run                          # the evening run (the timer calls this)
node cli.mjs sources | decode | picks | pack
node cli.mjs applied <company> [role]     # you applied: picks move on
node cli.mjs status <company> interview|offer|rejected|skipped [role] [--note "..."]
node cli.mjs list
node cli.mjs timer [HH:MM]                # reinstall the daily timer from settings.json (run_time, timezone)
node cli.mjs reset --yes                  # clear data/ (e.g. after trying the example profile)
```

## Configuration

| File | What | Committed? |
|---|---|---|
| `settings.json` | model provider (`claude` or `codex`) and models, sources and their filters, picks, Telegram | no |
| `.env` | tokens: `RTJ_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GMAIL_*` (written by `tools/gmail-auth.mjs`) | no |
| `profile/` | `profile.md`, `cv-library.json`, `fact-rules.json`, `voice.md`, `cover-letter-template.md` | no |
| `data/` | the queue, digests, packs, state | no |

Models: decoding uses `llm.model` (a mid-size model is enough), packs use `llm.pack_model` (use the strongest you have). On smaller plans, lower `decoder.cap` or use a smaller model.

`JOBPILOT_HOME`, `JOBPILOT_DATA` and `JOBPILOT_SETTINGS` point jobpilot at another folder, data directory or settings file (handy for trials and evals).

### Gates

Gates are hard rules every source applies before a job is queued, so a job you could never take costs no model call. They live in `settings.gates`; every key is optional, and a missing key means no check. With no `gates` block at all, sources work exactly as before. The example file turns some gates on (languages, work authorization, on-site countries, remote regions, sponsorship phrases); edit them to fit you.

```json
"gates": {
  "user": { "citizenships": [], "work_authorization": ["ES"] },
  "languages": ["en", "es"],
  "onsite_countries": ["ES"],
  "remote": { "accept_worldwide": true, "accept_regions": ["Europe*", "EU", "EEA", "EMEA"] },
  "sponsorship_refusal_phrases": ["without sponsorship", "no visa sponsorship", "must be authorized to work in"],
  "must_reside_phrases": [],
  "headcount": { "demote_over": null, "reject_over": null, "demote_unless": ["remote_worldwide", "remote_region", "sponsorship"] },
  "companies": { "exclude": [], "agencies": [] },
  "industries": { "exclude": [] }
}
```

Checks run in this order, and the first one that rejects wins:

1. **company:** the company is in `companies.exclude` or `companies.agencies`.
2. **industry:** an industry, the company or the title matches `industries.exclude`.
3. **language:** the posting is in none of your `languages`, or it needs another language at B2 or higher (a lower level is only flagged). Codes compare by language only, so `en-US` counts as `en`; names and 3-letter codes (`English`, `eng`, `spa`, `ger`) count as the 2-letter code.
4. **legal:** your citizenship is not accepted, or a work permit is required (or sponsorship refused) for an on-site job outside `user.work_authorization`. When the source says sponsorship is available, this is a flag, not a reject. For jobs that are not on-site only (remote, or attendance unknown) it is a flag too.
5. **geo:** an on-site or hybrid job with no country in `onsite_countries`, or a job that excludes a country you can work in.
6. **remote:** a remote job limited to regions you did not accept, worldwide remote when `accept_worldwide` is false, or a `must_reside_phrases` hit. A region is accepted when it matches `accept_regions` or names a country in `work_authorization` or `onsite_countries` ("Spain", "the Netherlands", "España", "ES"). A job that also has an office or hybrid location in one of those countries passes with a flag; so does one with a location there whose attendance is not listed (flagged "attendance unknown"), but a remote-only location there does not count. Without `accept_regions`, or when the job lists no regions, a region limit is only flagged. Region text with an exclusion ("Worldwide except US", "кроме") is always flagged for you to check and never rejects by itself.
7. **headcount:** off unless you set it (`null` means no limit). More people than `reject_over`, or more than `reject_keywords_over.min` with one of its keywords in the industries or title, rejects. Over `demote_over`, the job is held back (demoted) unless one of `demote_unless` holds.

Names match as whole words, case-insensitive, in any script; end a term with `*` to match word prefixes (`Europe*` matches "European Union"). A field a source does not know (RealtimeJobs gives the most, ATS boards and LinkedIn give the least) never rejects a job. Each source logs how many jobs each gate stopped, and flags on a queued job go into its `gate_flags` field. Demoted jobs are not lost: each one is added once to `data/state/demoted.jsonl` (date, source, company, role, url, gate, reason), so you can look them over before lowering the bar. `node cli.mjs doctor` shows which gates are on and warns about unknown keys.

### hh.ru alerts

For hh.ru users: with `sources.hh_alerts.enabled`, every run reads your hh.ru saved-search emails ("Вакансии по подписке") and resume-match emails ("Подходящие вакансии") from Gmail (read-only, the same access as LinkedIn alerts: run `node tools/gmail-auth.mjs` once), takes the vacancy numbers from them and reads each public vacancy page, without logging in to hh.ru. The links in those emails carry a login key; jobpilot never opens, logs or stores them, it only opens `https://hh.ru/vacancy/<number>` and does not follow redirects. Jobs are queued with `source: "hh"`, the city and work format as the location, the salary, experience and employment type, and the alert names in `notes`.

```json
"hh_alerts": {
  "enabled": true, "sender": "noreply@hh.ru",
  "first_run_hours": 72, "overlap_hours": 24, "max_lookback_hours": 168,
  "max_fetch": 40, "delay_ms": 3000,
  "title_include": [], "title_exclude": ["стажер", "стажёр", "intern", "junior"],
  "must_reside_phrases": ["находиться на территории РФ", "проживание в России"],
  "abroad_signals": ["из любой страны", "релокант*"],
  "tax_residency_phrases": ["налоговый резидент*"],
  "city_countries": { "Лимасол": "CY" }
}
```

- `title_include` and `title_exclude` take Russian and English terms (whole words; end a term with `*` for word prefixes). An empty `title_include` lets every title through.
- `must_reside_phrases`: for a remote job, phrases that mean you must live in a given country. A hit rejects the job (gate `geo-remote`). Useful when you live abroad and many remote jobs need you to be in Russia; the example file leaves it empty.
- `abroad_signals`: phrases that suggest working from abroad is fine. When the list is not empty, every remote job gets a flag: the signals found, or "confirm working from your country is allowed" when there are none.
- `tax_residency_phrases`: a hit adds a flag (a tax residency requirement is worth checking before you apply).
- `city_countries`: extra city to country pairs. Major Russian and nearby cities are built in; the country is what the on-site gate checks, so an on-site job in Moscow is rejected when RU is not in your `gates.onsite_countries`. A city that is not known leaves the country empty, which never rejects.

The shared gates then apply as for every source. A posting written mostly in Cyrillic counts as Russian for the language gate, so add `"ru"` to `gates.languages` if you use that gate (`doctor` warns when it is missing). Pages are read one at a time, at least 2 seconds apart (`delay_ms`, default 3), at most `max_fetch` per run. A 403 alone means the vacancy is hidden from visitors who are not logged in; two 403s in a row or a 429 mean hh.ru is slowing jobpilot down, so the run stops. Archived and removed vacancies are skipped. Three pages in a row without a title or description stop the run too (hh.ru probably changed its page layout). Vacancies left over for any of these reasons, or past `max_fetch`, are kept in `data/state/hh-alerts.json` and tried first on the next run. Try it with `node sources/hh-alerts.mjs --dry-run` (writes nothing), test single vacancies with `--ids 123456789,987654321` (no Gmail), or look further back with `--hours 168`.

### Outcomes from Gmail

With `sources.outcomes.enabled`, every run reads recent emails (read-only, the same Gmail access as LinkedIn alerts) and looks for answers to your applications: received, rejection, interview, test task, offer. Job alerts, newsletters and job-board notices ("your application was viewed", "похожие вакансии", resume statistics) are skipped without a model call (by subject; job boards such as hh.ru also send real invitations and rejections, so their senders are not skipped). Each remaining email is classified by the model (the body decides, not the subject) and matched to an application by company and role. When both the email and the application name a role, they must share a word other than generic ones (senior, lead, manager, engineer, developer, старший, менеджер and the like); a company where you have exactly one application is the exception, except for a rejection that names a different role, which goes to the unmatched list. A match adds an event to `data/state/applications.json` and updates the status (rejected, interview, offer); an older email never overrides a status recorded later. A later interview, test task or offer email reopens a rejected or closed application only when it names the same role or the company has just that one application; the report then says "reopened" and the application gets a `reopened` event. When the email gives a date for the event (an interview day, a deadline), it is kept as `event_date` on the event. Each recorded outcome runs the `outcome` hook.

Every run writes a report to `data/digests/outcomes-YYYY-MM-DD.md` (appended when there are several runs a day): the recorded outcomes, and the emails it could not match, each with a link to the email, so you can record them with `node cli.mjs status <company> <status> --manual`. With Telegram on, the same report is sent there too; `--no-telegram` skips that, the file is written either way.

```json
"outcomes": { "enabled": true, "query": "newer_than:3d -category:promotions -category:social", "max_emails": 50, "overlap_hours": 24, "account_index": 0, "model": null }
```

`model: null` uses `llm.model`. Each email is read once (by Gmail id). After the first run the search starts at the last run minus `overlap_hours` and `newer_than:` is dropped, so a few days without a run lose nothing. `max_emails` caps the emails sent to the model per run; the rest are picked up by the next run, oldest first. `account_index` is the `N` in `mail.google.com/mail/u/N/` for the links (0 unless you read this mailbox as a second Google account). Try it with `node sources/outcomes.mjs --dry-run` (classifies and prints, writes nothing); backfill with `--since YYYY-MM-DD`; `--no-telegram` writes the report file only. Company aliases come from `queue.aliases` (`[["Acme", "Acme Labs"]]`) if you set them.

### Hooks

Hooks let your own scripts react to the pipeline without changing jobpilot, for example to copy decodes into your notes or update a tracker:

```json
"hooks": {
  "decoded": "node ~/my-scripts/to-notes.mjs",
  "picks": ["node ~/my-scripts/calendar.mjs", "node ~/my-scripts/notify.mjs"],
  "timeout_sec": 60
}
```

Events: `before_run`, `job_written`, `decoded`, `picks`, `pack_built`, `outcome`, `run_done`. Each command gets the event as JSON on stdin (`{ "event", "at", ...details }`). A hook that fails or runs too long is logged and never stops the run. `node cli.mjs doctor` lists configured hooks and flags unknown event names.

The `outcome` event carries: `key` (the application), `company`, `role`, `type` (rejection, interview, test_task, offer, application_received), `status` and `previous_status`, `reopened` (true when a rejected or closed application was reopened), the event fields `date` (the email's day), `round` and `event_date` (when given), `note` (the evidence sentence), `source` (`gmail`) and `gmail_id`, plus `thread_id`, `email_date` (the email's Date header as received, or the time Gmail received it when there is none), `from`, `subject` and `evidence` (the same sentence as `note`).

### External producers (drop-dir)

Another program that finds jobs (a web-searching agent, a scan over some other pipeline, a script you wrote) can hand them to jobpilot by dropping files into a folder, without jobpilot knowing anything about where they came from. Enable it with:

```json
"sources": {
  "drop_dir": {
    "enabled": true,
    "dir": "/home/youruser/jobpilot-drop",
    "settle_sec": 60,
    "move_processed_to": "/home/youruser/jobpilot-drop/processed",
    "max_fetches_per_run": 40
  }
}
```

jobpilot checks `dir` on every run (`node cli.mjs sources` or the evening run) and accepts two kinds of file. A file is only touched once it has been sitting for `settle_sec` seconds, so a writer that is still appending to it is left alone. Only `*.md` and `*.queue.json` files are read; dotfiles and anything else (desktop.ini, editor swap files, sync clients' temp files) are ignored.

1. **A job file in jobpilot's own format**: front matter (`company`, `role`, `url`, `source`, `location`, ...) followed by the job text, the same shape jobpilot itself writes to `data/inbox`. It is queued with the normal dedupe rules, then moved to `processed/`. A file missing `company` or `role` is moved to `failed/` with a `.reason.txt` beside it rather than queued half-wrong.
2. **A `*.queue.json` file**: `{ "candidates": [{ "title": "...", "url": "...", "company": "optional", "location": "optional", "source_key": "optional" }] }`, the shape a search-style tool naturally produces (a page title and a link). For each candidate, jobpilot fetches the full job text itself (from the ATS API when the link is a known Greenhouse, Ashby, Lever, Workable or Recruitee posting, otherwise the page), works out the company from whichever of `company`, the page title, the fetch, or the link's board slug is the most specific, and skips search-result pages and jobs it cannot identify. Jobs are queued with `source: "drop:<source_key or file name>"`. Closed postings and links that redirect to a listing page or the home page are skipped too. The queue file is only moved to `processed/` once every candidate in it has a final answer. A page that could not be fetched (a rate limit, a server error, a network hiccup) keeps the file in place and is tried again on the next run, up to 3 runs; a 401, 403 or 451 is final at once. A job that stays unreadable is still queued without text when its company and role are known (open the link to read it), and reported as unreadable otherwise, so no file waits forever. A company only guessed from the title's punctuation ("Co - Title") does not count as known there. A queue file that is not valid JSON goes to `failed/`. jobpilot fetches pages slowly (1.5 seconds apart), at most `max_fetches_per_run` pages per run (default 40; calls to a known ATS API do not count), only over http or https, and never from this machine or a private network. Jobs past that limit stay in their file and are fetched on the next run. Files saved with a UTF-8 byte order mark (common with Windows tools) are read normally.

### Tests

`npm test` runs the unit tests (no network, no model calls).

## Status

v0.1, first testers. Working: ATS boards, RealtimeJobs and LinkedIn-alerts sources, outcomes from Gmail, decode, picks, packs (Claude and Codex), Telegram, installer. Next: guided onboarding polish from tester sessions, Hirify source, evals for your own voice and CV quality.

## License

MIT, see [LICENSE](LICENSE).
