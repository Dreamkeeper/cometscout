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

- **Sources** (all optional): public Greenhouse, Ashby and Lever boards of your target companies (no login); RealtimeJobs API (your token); LinkedIn job-alert emails, read from your Gmail with read-only access, each job's full text taken from LinkedIn's public job page. More sources (Hirify, hh.ru) are being ported.
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

Gates are hard rules every source applies before a job is queued, so a job you could never take costs no model call. They live in `settings.gates`; every key is optional, and a missing key means no check. With no `gates` block at all, sources work exactly as before.

```json
"gates": {
  "user": { "citizenships": ["XX"], "work_authorization": ["ES"] },
  "languages": ["en"],
  "onsite_countries": ["ES", "DE"],
  "remote": { "accept_worldwide": true, "accept_regions": ["Europe", "EU", "EMEA"] },
  "sponsorship_refusal_phrases": ["without sponsorship", "no visa sponsorship"],
  "must_reside_phrases": [],
  "headcount": { "demote_over": 500, "reject_over": null, "reject_keywords_over": { "min": 500, "keywords": ["smart home"] }, "demote_unless": ["remote_worldwide", "remote_region", "sponsorship"] },
  "companies": { "exclude": [], "agencies": [] },
  "industries": { "exclude": [] }
}
```

Checks run in this order, and the first one that rejects wins:

1. **company:** the company is in `companies.exclude` or `companies.agencies`.
2. **industry:** an industry, the company or the title matches `industries.exclude`.
3. **language:** the posting is in none of your `languages`, or it needs another language at B2 or higher (a lower level is only flagged).
4. **legal:** your citizenship is not accepted, or a work permit is required (or sponsorship refused) for an on-site job outside `user.work_authorization`. For remote jobs this is a flag, not a reject.
5. **geo:** an on-site or hybrid job with no country in `onsite_countries`, or a job that excludes a country you can work in.
6. **remote:** a remote job limited to regions you did not accept (unless it also has an office in a country you accept), worldwide remote when `accept_worldwide` is false, or a `must_reside_phrases` hit.
7. **headcount:** more people than `reject_over`, or more than `reject_keywords_over.min` with one of its keywords in the industries or title. Over `demote_over`, the job is held back (demoted) unless one of `demote_unless` holds.

Names match as whole words, case-insensitive, in any script. A field a source does not know (RealtimeJobs gives the most, ATS boards and LinkedIn give the least) never rejects a job. Each source logs how many jobs each gate stopped, and flags on a queued job go into its `gate_flags` field. `node cli.mjs doctor` shows which gates are on and warns about unknown keys.

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

### Tests

`npm test` runs the unit tests (no network, no model calls).

## Status

v0.1, first testers. Working: ATS boards, RealtimeJobs and LinkedIn-alerts sources, decode, picks, packs (Claude and Codex), Telegram, installer. Next: guided onboarding polish from tester sessions, Hirify source, outcome tracking from Gmail, evals for your own voice and CV quality.

## License

MIT, see [LICENSE](LICENSE).
