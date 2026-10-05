# Roadmap

> CometScout was called jobpilot until October 2026 (task 16 renamed it; the old names still work for a release or two).

CometScout started as one person's job-search pipeline and is being rebuilt as a product anyone can install. The goal of the current work: reach parity with that original pipeline, prove the quality with evals on identical inputs, then grow into a web workspace (a PWA that also opens as a Telegram Mini App, plus one Telegram bot) so nobody needs a Claude Code session after setup.

Status legend: ✅ done · 🔨 in progress · ⏳ next · 💤 later. Task briefs for self-contained pieces are in `docs/tasks/`.

## Done

- ✅ Sources: public ATS boards (Greenhouse, Ashby, Lever), RealtimeJobs API, LinkedIn job-alert emails via Gmail
- ✅ Decode (verdicts, gates in the prompt, history, fact flags), daily picks, digest, application packs (CV, cover letter, form answers), Telegram
- ✅ Install script, `doctor`, systemd timer, run lock, run date pinned per run
- ✅ Hooks (`settings.hooks`), `COMETSCOUT_SETTINGS`, extra front-matter fields, export / import (the first export format, v1), decoder context files, application `events[]`
- ✅ Unit tests (`npm test`)
- ✅ Status `accepted` for jobs the user holds: closes the role for picks and dedupe, never set or undone by email, "Jobs I hold" in the coach hand-off, Offer in the tracker export (`docs/tasks/14-accepted-status.md`)
- ✅ Interview coach as an optional onboarding step: installer from upstream (`deploy/modules/coach.sh`, `coach.ps1`), `cli.mjs coach-handoff`, doctor lines (`docs/tasks/13-coach-onboarding.md`)
- ✅ Parity with the original pipeline (M2, the table below): every source, shared gates, aliases and dedupe, outcomes from Gmail, picks and decoder parity, pack lint, tracker export, scorecard, health ping, failure alert, Russian labels. Checked on its real data: identical tracker rows (95 of 95), gate replay with no unexplained hard-gate difference, outcome tracking agreeing on 28 of 30 events

## Parity (M2)

| Piece | Brief | Status |
|---|---|---|
| Shared gates module: languages, work authorization and citizenship, on-site countries, remote scope, sponsorship refusals, company-size bands, company exclude / agencies / suppress after rejection, industries; used by every source. Suppress after rejection is left for after task 06 (outcomes), which records the rejections it needs | `docs/tasks/01-gates.md` | ✅ |
| hh.ru alert emails source (Gmail + public vacancy page) | `docs/tasks/02-hh-source.md` | ✅ |
| Hirify source (saved filters, session cookie) | `docs/tasks/03-hirify-source.md` | ✅ |
| Shared `lib/fetch-detail.mjs` (full job text from Greenhouse, Ashby, Lever, Workable, Recruitee, JSON-LD, page; company from search titles) + `drop-dir` source for external producers (e.g. OpenClaw) | `docs/tasks/04-fetch-detail-and-drop-dir.md` | ✅ |
| career-ops source (its pipeline and scan history) | `docs/tasks/05-career-ops-source.md` | ✅ |
| Outcome tracking from Gmail (rejection, interview, test task, offer, application received → `applications.json` events) | `docs/tasks/06-outcomes.md` | ✅ |
| Tracker export (job-pipeline-tracker JSON), source scorecard, health ping URL, failure alert unit, `locale: ru` labels | `docs/tasks/09-reports-and-ops.md` | ✅ |
| Company alias families, dedupe against the user's applications, alias-aware decoder history with a cutoff for evals, fact-rule negation guard, `decoder.prompt_file`, picks parity (closed roles by alias and role overlap, band, shape bonus, on-site exclusion, archived links), `screen` status | `docs/tasks/07-decoder-picks-parity.md` | ✅ |
| Pack lint rules from the profile (`profile/lint-rules.json`), vetted fallback, refuse a CV that still breaks a rule | `docs/tasks/08-pack-lint.md` | ✅ |

## Updates, backups, export (self-hosted)

Updates are notify only: a daily check, release notes in the bot and the workspace, one tap to update. Every update makes a backup, installs side by side, migrates data with expand-then-contract rules, verifies itself and rolls back automatically on failure. Export and backups use one ZIP format (`cometscout-export` v2) the user can open and read.

| Piece | Brief | Status |
|---|---|---|
| Export v2 (ZIP), import with conflict modes, encrypted secrets export, nightly backups, restore | `docs/tasks/11-export-v2-and-backups.md` | ✅ |
| The rename to CometScout in the code: new names written and printed, the old ones still read (`lib/legacy-names.mjs`), old units replaced by `cli.mjs timer` | `docs/tasks/16-rename-to-cometscout.md` | ✅ |
| Releases (`release.json`, generated `CHANGELOG.md`, `docs/RELEASING.md`), the `app/releases` layout with `app/current` and `update --adopt`, the update check with the Telegram notice and bot buttons, `cli.mjs update` (backup, side-by-side install, migrations, verify, automatic rollback), `cli.mjs rollback`, What is new in the workspace | `docs/tasks/12-releases-and-updates.md` | ✅ |

## Evals (M3)

`evals/decode.mjs` (verdicts against human labels: confusion table, surfaced precision/recall, gate correctness, paired comparison of two systems, no history leakage), `evals/pack.mjs` (blind A/B judge for CVs and answers), `evals/voice.mjs` (does it sound like the user), `evals/shadow-diff.mjs` (two systems on the same days). ⏳ next; starts with a human labelling session of about 70 jobs.

## Workspace (M5)

A web workspace instead of chat-only control, so nobody needs a Claude Code session: a PWA that is fullscreen and dense on the desktop, installable on the phone with offline access and Web Push, and opens as a Telegram Mini App (same code, same URL). One Telegram bot in a private chat for picks with buttons, outcome cards and alerts (a topics group stays optional). UI: Preact + htm with no build step; the Node server stays dependency-free; self-hosted with HTTPS set up by the installer. Optional modules installed from upstream (`deploy/modules/*.sh`): OpenClaw, career-ops, an interview-coach skill, meeting transcription (GPU worker or CPU fallback). Recommended server for the full workspace: 4 vCPU / 8 GB RAM.

| Piece | Brief | Status |
|---|---|---|
| M5a probe: `cli.mjs serve` and the "Today" screen (picks, decode, pack review, applied / skip / later); a week of daily use on real data decides the rest | `docs/tasks/10-workspace-today-screen.md` | 🔨 |
| PWA platform (manifest, service worker, Web Push, sign-in via Telegram launch data or a login link, HTTPS installer), the other screens, the rest of the bot (picks with Apply / Skip / Later, outcome cards), modules | later briefs | 💤 |
| Digest days and time (`schedule`), off days, interview prep mode (`picks.prep`), `cli.mjs interview`, the workspace settings dialog, and the first bot commands (`cli.mjs bot`: `/schedule`, `/time`, `/interview`, `/help`) | `docs/tasks/15-digest-days-and-interview-prep.md` | ✅ |
| Interview coach, first step: installer and hand-off file, optional onboarding step | `docs/tasks/13-coach-onboarding.md` | ✅ |
| Interview coach, deeper: automatic hand-offs from picks and outcome emails (a new interview starts a prep), a coach chat inside the bot or the workspace | later brief | 💤 |
