# 26: Fixes from the first end-to-end onboarding test

## Why
On 2026-10-24 a fictional job seeker went through "set me up" (`AGENTS.md`) on a fresh 4-vCPU Debian 13 server running v0.2.1, with Claude Code as the onboarding agent. The flow works: a decoded job after 18 minutes and a tailored CV after 28, with no invented CV facts. But the first result was polluted by the example profile, the decoder invented an application that never happened, verdicts changed between two runs on the same jobs, and several steps of `AGENTS.md` were followed loosely or point at stale files. This task fixes all of it, so the same test can be re-run as a regression check before real users onboard.

Read `DEVELOPMENT.md` and `CLAUDE.md` first. No new dependencies. Every change gets a test; `npm test` must pass on Linux and Windows. Two PRs: **A** (decoder, items 1 to 3) first, then **B** (everything else), each against the current `main`.

## PR A: the decoder

### 1. The decoder invents applications from its own decodes
`history()` in `decoder/decoder.mjs` lists the user's recorded applications and CometScout's past decodes of the same company under one heading ("History with <company>"), the decodes as `- <date>: decoded "<role>": <verdict>`. The model read a sibling decode as an earlier application ("mention the earlier Docplanner application"), and the claim reached the pack's `answers.md` through the decode's action line.
Fix:
- Two blocks with plain headings: "Applications and outcomes the user recorded" (from applications.json; when empty, the line `none: the user has not applied to this company`) and "Other roles at this company that CometScout read (not applications)".
- The second block lists date and role title only, no verdict (see item 2).
- The decoder prompt says once, in its rules, that only the first block is the user's history; the second block may be used to spot duplicates and the company's hiring pattern, never stated as something the user did.
- Tests: a company with only past decodes produces the `none` line and no verdict text; a company with a recorded application shows it in the first block.

### 2. Verdicts change between runs because the decoder anchors on its own verdicts
The same four jobs were all held in one run and, 15 minutes later, three were investable stretches and one became the day's pick. One rationale said a job was a stretch "because the same role in another location was rated investable-stretch": the earlier decode from the same batch was in the prompt.
Fix:
- Past decodes never carry their verdict into the prompt (item 1).
- Decodes from the same run, and any decode dated the same day, are left out of the second block entirely (the run knows its own files; `before` already exists for replays).
- `evals decode` gains `--repeat N`: decode the same set N times (default 2) and report, per job and in total, how many verdicts and priorities changed. Document it in the README's evals section. Do not try to make the model deterministic by other means in this task; measure first.

### 3. Decode cost is not recorded
Packs write `cost_usd`; decodes do not, so a first run's cost cannot be measured. `lib/llm.mjs` already returns the cost. Write `cost_usd` into each decode result block and sum it per run into `runs.jsonl` and the digest footer (one line: decodes, packs, total). Tests with a fake call returning a cost.

## PR B: onboarding, doctor and operations

### 4. The example profile leaks into the first result
`settings.example.json` sets `candidate_name` to the example person, `AGENTS.md` never mentions it, and the first digest after a real profile carried that name plus two picks decoded for the example profile. The reset offer only comes in step 8, after the first result.
Fix:
- `candidate_name` defaults to null in the example settings; when null, it is read from the first heading or a `Name:` line of `profile/profile.md`.
- `doctor` gets a TODO when `profile/` exists but `candidate_name` still equals the example name, and when `data/` holds decodes made before `profile/` was created ("decodes from the example profile: `node cli.mjs reset --yes` clears them").
- `AGENTS.md`: the reset question moves to the start of step 7, before `sources`.

### 5. `doctor` says the claude CLI is missing when it is installed
Claude Code's installer puts `claude` in `~/.local/bin`, which a plain `ssh host "cmd"` shell does not have on its PATH. `doctor` then says "install Claude Code", which sends a non-developer to reinstall it. The timer is fine (`lib/ops.mjs` adds `~/.local/bin` to the unit's PATH, twice: dedupe it).
Fix: when the bare name is not found, check `~/.local/bin/<bin>`; if it is there, report ok with "found in ~/.local/bin (this shell's PATH lacks it; the timer adds it)". Tests with a fake home.

### 6. Stale code and docs in the home after `update --adopt`
After adopting a git-clone install, the home keeps the old clone's code and docs; 14 files differed from `app/current`. `node cli.mjs` hands over correctly, but `AGENTS.md` (which the onboarding agent reads from the home) is the old version and tells it to run `bash deploy/install.sh` and `bash deploy/modules/coach.sh` from the home, which are the old scripts.
Fix (choose the safest mechanism and explain it in the PR; nothing may be deleted without a copy):
- Every update and adopt refreshes the user-facing docs in the home (`AGENTS.md`, `CLAUDE.md`, `README.md`, `README-rus.md`, `INSTALL.md`) from the installed release.
- Scripts the docs tell the user or agent to run must resolve to the installed release: either `node cli.mjs install-module <coach|transcribe> [args]` (runs `app/current/deploy/modules/...`) with `AGENTS.md` and the README using it, or the home's copies replaced by thin wrappers. Same for `deploy/install.sh`.
- The adopted clone's other code files are moved aside (for example `app/adopted-clone-<version>/`) or left with a clear notice; say which and why. Extend `tools/rehearse` to check that after adopt plus update no stale script is reachable from the home's docs.

### 7. `reset --yes` deletes install state
`cli.mjs` reset clears every file in every data folder except `run.lock`, including `data/state/schema.json` (which migrations ran), `data/state/update.json` (update history) and `runs.jsonl`. A later update could re-run migrations on a reset home.
Fix: keep those three (they describe the install, not the job queue); the confirmation message lists what is kept. Test.

### 8. `timer` starts a full run at once
`node cli.mjs timer` re-created the units and systemd started the evening run immediately (`Persistent=true` catch-up). On a weekday with new jobs that decodes and builds packs with no warning.
Fix: installing or changing the timer never starts a run by itself (the next run is the next scheduled time); `timer` prints the next run time. If a catch-up after downtime is still wanted, keep it only once a scheduled run has happened. Test the unit text and the logic that decides it; the rehearsal checks no run starts at install.

### 9. `AGENTS.md`: follow-the-rules fixes
The onboarding agent asked four to six questions in one turn, saved some settings before showing them, skipped two optional sources without asking, and listed the interview coach as "optional, later" instead of asking. Rewrite the relevant lines so a model follows them literally:
- "One question per turn. A turn may also ask for yes/no confirmations of what you just wrote, nothing else." The profile interview in step 2 becomes a numbered list of single questions.
- Every write to `settings.json`, `profile/` or `.env` instructions: show the exact change (a diff, or the new file) and wait for yes. Add `node cli.mjs settings set <key> <json-value> [--dry-run]` that reuses the MCP server's validated `settings_set` (schema check, diff, write), and use it in `AGENTS.md`.
- Step 6 as a checklist asked in order: job boards; "Do you have a RealtimeJobs API token?"; "Do you get LinkedIn job alerts in Gmail?"; other links via the drop folder. Name the supported board systems (item 10) and say what to do for others.
- Step 8: before running `timer`, say when the first run will happen.
- Step 9: "Ask once, even if Telegram was put off: digests in data/digests count as delivery working."
- Start of "set me up": run `node cli.mjs onboarding-state` (item 12) and continue from the step it names.

### 10. Personio boards
Two of eight target companies used systems `ats_boards` cannot read. Personio is common among European employers and has a public XML feed (`https://<company>.jobs.personio.de/xml`, also `.com`). Add `personio` to `ats_boards` (title, location, remote flag, link, description), with fixtures that match the real feed's shape (fetch one live feed to check, do not commit its contents; write a synthetic fixture with the same structure). Gem (`jobs.gem.com`) only if it has a public, unauthenticated JSON API; otherwise document it as "use the drop folder".

### 11. Small ones
- `drop_dir` paths in `settings.example.json` use `/home/youruser/...`: default to `~/cometscout-drop`, `~` resolved at runtime, the folder created on first use.
- `answers.md` salary: never put the floor in as the expectation. Leave the answer blank with the floor and the posting's range (if any) as a note for the user to decide.
- `profile.example/fact-rules.json`: make the P&L example verb-anchored ("ran/owned/managed ... P&L") like the people-management one, so a posting's own "P&L ownership" is not flagged.

### 12. `node cli.mjs onboarding-state`
The MCP server's `onboarding_state` knows which steps are done; the shell path has nothing, so a resumed session relied on the agent's private memory. Add the command (same logic, human-readable lines plus `--json`), and use it in `AGENTS.md` (item 9).

## Done when
- PR A merged: history in two labelled blocks, no verdicts and no same-run decodes in the prompt, `evals decode --repeat`, decode cost in results, runs and the digest. Tests.
- PR B merged: items 4 to 12, with tests and the rehearsal extended (items 6 and 8).
- `CHANGELOG.md` and `release.json` entries in the next unreleased version for user-visible changes.
- The maintainer then re-runs the onboarding test with the same fictional persona on the test server; that run is not part of this task.
