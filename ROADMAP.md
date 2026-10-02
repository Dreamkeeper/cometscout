# Roadmap

jobpilot started as one person's job-search pipeline and is being rebuilt as a product anyone can install. The goal of the current work: reach parity with that original pipeline, prove the quality with evals on identical inputs, then grow into a small workspace (one Telegram group with a topic per function).

Status legend: ✅ done · 🔨 in progress · ⏳ next · 💤 later. Task briefs for self-contained pieces are in `docs/tasks/`.

## Done

- ✅ Sources: public ATS boards (Greenhouse, Ashby, Lever), RealtimeJobs API, LinkedIn job-alert emails via Gmail
- ✅ Decode (verdicts, gates in the prompt, history, fact flags), daily picks, digest, application packs (CV, cover letter, form answers), Telegram
- ✅ Install script, `doctor`, systemd timer, run lock, run date pinned per run
- ✅ Hooks (`settings.hooks`), `JOBPILOT_SETTINGS`, extra front-matter fields, export / import (`jobpilot-export-v1`), decoder context files, application `events[]`
- ✅ Unit tests (`npm test`)

## Parity (M2)

| Piece | Brief | Status |
|---|---|---|
| Shared gates module: languages, work authorization and citizenship, on-site countries, remote scope, sponsorship refusals, company-size bands, company exclude / agencies / suppress after rejection, industries; used by every source. Suppress after rejection is left for after task 06 (outcomes), which records the rejections it needs | `docs/tasks/01-gates.md` | ✅ |
| hh.ru alert emails source (Gmail + public vacancy page) | `docs/tasks/02-hh-source.md` | ✅ |
| Hirify source (saved filters, session cookie) | `docs/tasks/03-hirify-source.md` | ✅ |
| Shared `lib/fetch-detail.mjs` (full job text from Greenhouse, Ashby, Lever, Workable, Recruitee, JSON-LD, page; company from search titles) + `drop-dir` source for external producers (e.g. OpenClaw) | `docs/tasks/04-fetch-detail-and-drop-dir.md` | ✅ |
| career-ops source (its pipeline and scan history) | `docs/tasks/05-career-ops-source.md` | ✅ |
| Outcome tracking from Gmail (rejection, interview, test task, offer, application received → `applications.json` events) | `docs/tasks/06-outcomes.md` | ✅ |
| Tracker export (job-pipeline-tracker JSON), source scorecard, health ping URL, failure alert unit, `locale: ru` labels | `docs/tasks/09-reports-and-ops.md` | 🔨 |
| Company alias families, dedupe against the user's applications, alias-aware decoder history with a cutoff for evals, fact-rule negation guard, `decoder.prompt_file`, picks parity (closed roles by alias and role overlap, band, shape bonus, on-site exclusion, archived links), `screen` status | `docs/tasks/07-decoder-picks-parity.md` | ✅ |
| Pack lint rules from the profile (`profile/lint-rules.json`), vetted fallback, refuse a CV that still breaks a rule | `docs/tasks/08-pack-lint.md` | 🔨 |

## Evals (M3)

`evals/decode.mjs` (verdicts against human labels: confusion table, surfaced precision/recall, gate correctness, paired comparison of two systems, no history leakage), `evals/pack.mjs` (blind A/B judge for CVs and answers), `evals/voice.mjs` (does it sound like the user), `evals/shadow-diff.mjs` (two systems on the same days). 💤 after M2 starts.

## Workspace (M5)

One private Telegram supergroup with topics (Picks, Packs, Outcomes, Alerts, Sources, Interview coach, Transcription, OpenClaw, career-ops), created by the bot; jobpilot posts to topics; Claude Code bridge bots answer only in their topic; optional modules installed from upstream (`deploy/modules/*.sh`): OpenClaw, career-ops, an interview-coach skill, meeting transcription (GPU worker or CPU fallback). Recommended server for the full workspace: 4 vCPU / 8 GB RAM. 💤
