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

### Tests

`npm test` runs the unit tests (no network, no model calls).

## Status

v0.1, first testers. Working: ATS boards, RealtimeJobs and LinkedIn-alerts sources, outcomes from Gmail, decode, picks, packs (Claude and Codex), Telegram, installer. Next: guided onboarding polish from tester sessions, Hirify source, evals for your own voice and CV quality.

## License

MIT, see [LICENSE](LICENSE).
