# How to install CometScout on a Debian virtual machine

> CometScout was called jobpilot until October 2026. An install in `~/jobpilot` keeps working; `deploy/install.sh` finds it, leaves it in place and says how to move it.

Every evening CometScout collects job postings, judges each one against your profile, picks the best two and prepares a CV and draft answers for each application form. Every model step runs through your Claude or ChatGPT subscription; no separate API key is needed.

## What you need

- A virtual machine with Debian 12 or 13: 2 GB of RAM and 10 GB of disk or more.
- A normal user with sudo rights. Do not install as root.
- A Claude subscription (Pro or Max) or a ChatGPT subscription (Plus or Pro).
- Optional: a Telegram bot for the daily delivery, and Gmail if LinkedIn or hh.ru already send you job alerts by email.

## 1. Prepare the machine

If sudo is not there yet, log in as root and run (replace `NAME` with your user):

```bash
apt-get update && apt-get install -y sudo && usermod -aG sudo NAME
```

Then log in again as your user and install git and Node.js 20 or newer.

**Debian 13:** Node 20 is in the standard repositories.

```bash
sudo apt-get update && sudo apt-get install -y git curl nodejs npm
```

**Debian 12:** it ships Node 18, which is too old. Install a current version from NodeSource.

```bash
sudo apt-get update && sudo apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Check: `node -v` should show v20 or higher.

## 2. Claude Code or Codex

Install one of the two.

**Claude Code:**

```bash
curl -fsSL https://claude.ai/install.sh | bash
source ~/.profile
claude
```

The installer puts `claude` into `~/.local/bin`. Debian adds that folder to PATH at login, so right after installing you need `source ~/.profile` (or log in over SSH again).

On first start Claude Code shows a link. Open it in the browser on your own computer, sign in and paste the code the site shows into the terminal. After signing in, leave with `/exit`.

**Codex:**

```bash
sudo npm install -g @openai/codex
codex login
```

If the machine has no browser, follow the prompts of `codex login` for signing in without one.

## 3. Install CometScout

```bash
cd ~
git clone https://github.com/Dreamkeeper/cometscout.git
cd cometscout
bash deploy/install.sh
```

The installer asks for your sudo password once and then:

- installs Python, LibreOffice for the PDFs, and fonts;
- creates `settings.json` and `.env` (readable only by you);
- copies the code into `app/releases/v<version>/` with `app/current` pointing at it, so `node cli.mjs update` can install a new version next to it and go back if it fails (README: Updates); this folder stays the home for your settings and data;
- sets up the daily run at 18:00 with a failure alert. Until your profile exists (the `profile/` folder), the evening run does nothing. Set the days, the time and the time zone later in `settings.json` (`"schedule": { "days": [1, 2, 3, 4, 5], "time": "18:00" }`, `timezone`) and run `node cli.mjs timer`, or change them from the workspace or the Telegram bot;
- finally runs the check `node cli.mjs doctor`.

The check prints a list: `ok` means ready, `TODO` means something is left to do. Right after installing, the profile and settings items are `TODO`; that is expected.

## 4. Try it on the example

Until you have your own profile, CometScout runs on a fictional example person (Alex Rivera):

```bash
node cli.mjs sources
node cli.mjs decode --no-telegram
node cli.mjs pack --no-telegram
```

The results land in `data/`: decoded jobs, the picks of the day, and packs with a CV as PDF.

## 5. Make it yours

Open the folder in Claude Code or Codex:

```bash
cd ~/cometscout && claude
```

(or `codex` instead of `claude`) and say **"set me up"**.

The agent walks you through the steps, one question at a time:

1. **Profile:** who you are, which roles you are looking for, where you can work, what is out for you, and what must never be claimed about you.
2. **CV library:** the agent splits your CV into items and you confirm every line. Tailored CVs are built only from these items; the model invents nothing.
3. **Fact rules:** a check that catches overstatements.
4. **Your voice:** optional. Share two or three texts you wrote yourself, so form answers sound like you.
5. **First source:** the easiest start is the public job pages of companies on Greenhouse, Ashby and Lever. Name 5 to 10 companies and the agent finds their pages.
6. **First result:** a real job decoded against your profile and a CV for it, in the same sitting.

## 6. Delivery to Telegram

1. Create a bot with @BotFather and copy its token.
2. Find your chat id, for example with @userinfobot.
3. Open `.env` (`nano ~/cometscout/.env`) and add two lines:

```
TELEGRAM_BOT_TOKEN=token_from_BotFather
TELEGRAM_CHAT_ID=your_chat_id
```

4. In `settings.json` turn on `"delivery": { "telegram": { "enabled": true } }`, or ask the agent to.
5. For Russian labels in the messages (digest, picks of the day, application packs), add `"locale": "ru"` to `settings.json`. What the model writes is not translated.

If a timed run fails, the bot sends an error message (after `node cli.mjs timer`).

Run `node cli.mjs timer` once more after turning Telegram on: it also installs the bot service, which answers your chat (and nobody else's):

- `/schedule`: digest days, time and interview prep, with buttons to switch days on or off and to set prep days (0 to 3);
- `/time 19:30`: move the evening run;
- `/interview Company 2026-10-07 14:00`: record a booked interview (a company name with spaces goes in quotes);
- `/help`: the list.

On days that are off, the run still collects and decodes jobs but sends nothing; the next digest says what came in meanwhile.

**Put tokens into the file yourself and never paste them into the chat with the agent.**

## 7. Optional: LinkedIn and hh.ru job alerts through Gmail

This step is for people who already get job alert emails from LinkedIn or hh.ru.

1. In the Google Cloud Console create a project, enable the Gmail API, set up the consent screen (External, add yourself as a test user) and create an OAuth client of type "Desktop app". The agent can walk you through it.
2. Add `GMAIL_CLIENT_ID=...` and `GMAIL_CLIENT_SECRET=...` to `.env`.
3. On **your own computer**, open a tunnel to the machine:

```bash
ssh -L 8765:127.0.0.1:8765 NAME@machine_address
```

4. In that same SSH session run:

```bash
cd ~/cometscout && node tools/gmail-auth.mjs
```

5. Open the link the script prints in the browser on your computer, sign in and allow read-only access. The access key is written into `.env` by itself and is never shown.
6. Turn on the `linkedin_alerts` source (and `hh_alerts` for hh.ru) in `settings.json` and check it:

```bash
node sources/linkedin-alerts.mjs --dry-run --max-fetch 3
```

The same Gmail access lets CometScout notice answers to your applications (received, rejection, interview, test task, offer): turn on `sources.outcomes`. See [Outcomes from Gmail](README.md#outcomes-from-gmail).

The RealtimeJobs source is turned on the same way: the token `RTJ_API_TOKEN=...` in `.env` and `"rtj": { "enabled": true }` in the settings.

Hirify (remote and relocation jobs) is read through your session on the site: copy the value of the `Cookie` header from your browser into a line `HIRIFY_COOKIE="..."` in `.env` (yourself, not in the chat), add your saved filters to the `"hirify"` block in `settings.json` and check with `node sources/hirify.mjs --dry-run`. Details, including what to do when the session expires: the [Hirify](README.md#hirify) section of the README.

If you already run [career-ops](https://github.com/career-ops-hq/career-ops), CometScout can pick up what it finds: put the path of your career-ops folder into `sources.career_ops.path` and turn the source on. CometScout only reads `data/pipeline.md` and `data/scan-history.tsv` and never writes into the career-ops folder. Details: the [career-ops](README.md#career-ops) section of the README.

## 8. Every day

- In the evening, Telegram brings up to two of the day's best jobs, each with a pack: a CV as PDF, a cover letter if the form asks for one, and draft answers.
- You applied: `node cli.mjs applied Company`, so the job is not offered again.
- News from a company: `node cli.mjs status Company interview` (or `screen`, `offer`, `rejected`, `skipped`).
- You took an offer and work there, but keep looking: `node cli.mjs status Company accepted`. The job stops counting as an open process, and no email changes that status.
- An interview is booked: `node cli.mjs interview Company 2026-10-07 14:00` (or the bot's `/interview`, or Record interview in the workspace). In the 2 days before it, the digest leads with the interview and a prep step, and offers at most one new role, only a strong and fresh one; the rest wait until after the interview. `"picks": { "prep": { "days_before": 0 } }` turns this off.
- All your applications: `node cli.mjs list`.
- Clear the data after trying the example: `node cli.mjs reset --yes`.

## 9. Optional: transcribe your interview recordings

CometScout can turn a recording of an interview into text on this machine, so the interview coach can analyze it. The audio stays on the server; the model (about 1.5 GB for the default `medium`) is downloaded once by the first job.

```bash
bash deploy/modules/transcribe.sh                   # needs Python 3.10 to 3.14 and python3-venv: sudo apt-get install -y python3 python3-venv
node cli.mjs transcribe --bench sample.m4a --models small,large-v3-turbo   # which model is fast enough here
```

Then set `modules.transcribe.enabled` to `true` in `settings.json` (and `model` to what the bench suggested) and run `node cli.mjs timer`. Put recordings into `data/audio/inbox` (scp or Syncthing), upload them in the workspace, or send them to the bot (up to 20 MB). Transcripts appear in `data/transcripts/`. Details: the [Transcription](README.md#transcription-optional) section of the README.

## If something does not work

- `node cli.mjs doctor` shows what is missing and how to fix it.
- The evening run's log: `journalctl --user -u cometscout -n 100`.
- When the next run is: `systemctl --user list-timers cometscout.timer`.
- Run the whole pipeline by hand: `node cli.mjs run`.
