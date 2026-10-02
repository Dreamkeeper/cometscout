# 13: Interview coach as an optional onboarding step

## Why
For many users the most valuable part of a job search is not finding roles but getting through interviews: preparing for a company, practising answers, analysing a transcript, negotiating an offer. An open-source Claude Code skill already does this well: Noam Segal's interview coach (github.com/noamseg/interview-coach-skill, MIT). CometScout already holds what the coach asks for at its `kickoff` (who the user is, their CV, how they write, where they applied, which interviews are coming), so setting the two up together saves the user from telling the same story twice.

Maintainer decision: an optional onboarding step now (install + hand-off); deeper integration (automatic hand-offs from picks and outcome emails, a coach chat inside the bot or the workspace) comes later.

Read `DEVELOPMENT.md` first. Plain Node 20, no new dependencies, synthetic data only, no em dashes in user-facing text. Every change gets a test; `npm test` must pass on Linux and Windows. The coach's code is never copied into this repository: it is installed from its own upstream, with credit.

## 1. `deploy/modules/coach.sh` (and `coach.ps1` for Windows)
- Installs or updates the skill from upstream into a folder next to the CometScout home (default `<home>/../interview-coach`, or `modules.coach.path`): `git clone --depth 1` the first time, `git pull --ff-only` after; never touches the user's files in that folder (`coaching_state.md` and anything else the coach writes).
- Prints where it is and how to start it: `cd <path> && claude`, then `kickoff`.
- Settings: `modules.coach: { "enabled": false, "path": null, "repo": "https://github.com/noamseg/interview-coach-skill.git" }`.
- `doctor`: when enabled, shows whether the folder exists, the installed commit (short hash and date) and whether `claude` is on the PATH; a missing install is a TODO with the command to run.

## 2. `cli.mjs coach-handoff [--out <file>]`
Writes one Markdown file for the coach's `kickoff` (default `<coach path>/cometscout-handoff.md`), built only from the user's own files, newest facts first:
- **Who I am and what I want:** `profile/profile.md` as written (roles, years, strengths, targets, location and work authorization, hard gates, scope guards). Scope guards are labelled as such: "never claim".
- **My CV:** the vetted library rendered as a plain resume (taglines, summaries, every role with its bullets, skills, education, awards), so the coach reads the user's approved wording.
- **How I write:** `profile/voice.md` when it exists.
- **Where I stand:** applications from `data/state/applications.json` with status and last event (company, role, status, date), and interviews with a future `event_date` listed first with company, role and date.
- A header saying what the file is, when it was made, and that it is a snapshot (CometScout keeps the live record).
Never includes `.env`, tokens, cookies, packs or job texts. Prints the path and a one-line instruction ("In the coach, say: kickoff, and give it cometscout-handoff.md").

## 3. Onboarding (`AGENTS.md`)
Add an optional step after the daily delivery step: "Interview coach (optional)". The agent explains in two sentences what the coach does and that it is a separate open-source project; if the user wants it, runs the module installer, runs `coach-handoff`, and tells the user how to open the coach and start `kickoff` with the hand-off file. Ask, do not assume; one question at a time like the other steps.

## 4. Docs
README: a short "Interview coach (optional)" section with credit to the upstream project and its license, the two commands, and what the hand-off contains and leaves out. README-rus.md: a short Russian paragraph pointing to it. ROADMAP: the step is done; deeper hand-offs stay under the workspace milestone.

## Tests
`coach-handoff` against the example profile and a temp data dir (synthetic applications, one future interview): sections present, the interview listed first, no secret or job text, scope guards labelled; `--out` honoured; a missing profile gives a clear message. The installer: a test that runs it with `GIT` pointed at a fake command (records the arguments) for both first install and update, and confirms it never deletes files in the target folder. Doctor lines for enabled/disabled/missing.

## Done when
`npm test` passes on Linux and Windows; `node cli.mjs doctor` runs on the example profile; docs updated. PR description lists what was built, what was not and open questions.
