# jobpilot

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
- **Application pack:** the CV is assembled only from `profile/cv-library.json`, text you approved. The model selects and orders; it may write only the tagline and summary, and both are checked against your fact rules. The application form is read automatically for Ashby, Greenhouse and Lever, and every non-personal question gets a draft in your voice (`profile/voice.md`). Company blocks are never split across pages. A "check before sending" list names every decision that is yours (salary, location, gaps).

## Quick start

On a Debian or Ubuntu VPS, as your normal user:

```bash
git clone <this repo> jobpilot && cd jobpilot
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
```

## Configuration

| File | What | Committed? |
|---|---|---|
| `settings.json` | model provider (`claude` or `codex`) and models, sources and their filters, picks, Telegram | no |
| `.env` | tokens: `RTJ_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GMAIL_*` (written by `tools/gmail-auth.mjs`) | no |
| `profile/` | `profile.md`, `cv-library.json`, `fact-rules.json`, `voice.md`, `cover-letter-template.md` | no |
| `data/` | the queue, digests, packs, state | no |

Models: decoding uses `llm.model` (a mid-size model is enough), packs use `llm.pack_model` (use the strongest you have). On smaller plans, lower `decoder.cap` or use a smaller model.

## Status

v0.1, first testers. Working: ATS boards, RealtimeJobs and LinkedIn-alerts sources, decode, picks, packs (Claude and Codex), Telegram, installer. Next: guided onboarding polish from tester sessions, Hirify source, outcome tracking from Gmail, evals for your own voice and CV quality.
