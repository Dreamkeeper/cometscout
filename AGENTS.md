# jobpilot: instructions for the coding agent (Claude Code or Codex)

You are helping a job seeker set up and run jobpilot on their own server. The user has a Claude or ChatGPT subscription; jobpilot calls that CLI for every model step. Everything personal lives in `profile/`, `settings.json` and `.env`, which are never committed.

## When the user says "set me up" (onboarding)

Goal: the first useful result in one sitting, a real job decoded against their profile and a tailored CV for it, before anything optional. Ask one question at a time. Show what you write and get a yes before saving.

1. **Check the machine:** run `node cli.mjs doctor`. Fix what it lists, in order. Packages and the daily timer come from `bash deploy/install.sh` (it needs sudo once).
2. **Profile (`profile/profile.md`):** copy the structure of `profile.example/profile.md`. Interview the user for: who they are (roles, years, strengths, degree, languages), what they want (roles, domains, company size, pay floor), location and work authorization, hard gates (never show me X), scope guards (things they must never claim). Use their words; never add a fact they did not give.
3. **CV library (`profile/cv-library.json`):** ask for their CV (paste or file). Turn each bullet into a library item with an id, keeping their wording; add one or two taglines and summaries built only from those bullets. Show the whole library and let them correct every line: this file is the only source of facts for the CVs jobpilot builds.
4. **Fact rules (`profile/fact-rules.json`):** one regex rule per scope guard, so an overclaim gets flagged (see the example file).
5. **Voice (`profile/voice.md`, optional but valuable):** ask for two or three texts they wrote themselves (not AI-written). Describe how they write in a short card and quote a few of their sentences as rhythm reference.
6. **First source:** `settings.json` → `sources`. Fastest: `ats_boards`: ask for five to ten target companies, find each company's public board (Greenhouse `boards.greenhouse.io/<board>`, Ashby `jobs.ashbyhq.com/<board>`, Lever `jobs.lever.co/<board>`), set title and location filters. If they have a RealtimeJobs API token, enable `rtj` and put `RTJ_API_TOKEN=...` in `.env` (they paste it into the file themselves; never ask them to paste a token into chat).
   **LinkedIn alerts** (optional, most useful if they already get LinkedIn job-alert emails in Gmail): they create a Google Cloud project with the Gmail API enabled and an OAuth client of type "Desktop app" (you can walk them through the console), put `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` in `.env` themselves, then run `node tools/gmail-auth.mjs` and sign in in their own browser (on a VPS: `ssh -L 8765:127.0.0.1:8765 <vps>` first). The token goes straight into `.env`; never read or print it. Enable `linkedin_alerts` and test with `node sources/linkedin-alerts.mjs --dry-run --max-fetch 3`. Keep `max_fetch` and `delay_ms` modest: job pages are fetched from LinkedIn's public guest view, slowly, and the run stops by itself if LinkedIn throttles.
7. **First result:** `node cli.mjs sources`, then `node cli.mjs decode --no-telegram`, then `node cli.mjs pack --no-telegram`. Show the picks and open the pack's PDF and `answers.md` with them. This is the moment to fix the profile if a verdict or a CV line is off.
8. **Daily delivery:** Telegram: they create a bot with @BotFather and put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`; set `delivery.telegram.enabled`. Confirm the timer with `systemctl --user list-timers jobpilot.timer`.
9. **Tell them the daily loop:** every evening they get up to two picks with a pack each; after applying, `node cli.mjs applied <company>` so picks move on; `node cli.mjs status <company> interview|rejected|offer` for news.

## Rules
- Never invent facts about the user; the CV library and profile are theirs to approve.
- Never commit or print secrets. `.env` is chmod 600.
- Do not edit `profile.example/`; it is the public example.
- Prefer small, reversible changes to `settings.json`; explain each one in a sentence.
