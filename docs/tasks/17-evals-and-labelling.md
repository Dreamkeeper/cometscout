# 17: Evals and a labelling screen (M3)

## Why
CometScout decides which roles a user should apply to, and writes their CVs and answers. Users (and the maintainer, before switching his own search to it) need numbers, not impressions: how often does a "worth applying" verdict match what the user would have said, how many good roles does it hide, and is a generated pack better than the one it replaces? That takes human labels, and labelling is only done well when it is fast and the system's own verdict is hidden. This task builds the labelling screen and the eval scripts. Real labels stay with each user; the repository holds only synthetic fixtures.

Read `DEVELOPMENT.md` first. Plain Node 20, no new dependencies (the workspace keeps Preact + htm with no build step), synthetic data only, no em dashes in user-facing text, English and Russian labels. Every change gets a test; `npm test` must pass on Linux and Windows. Model calls go through `lib/llm.mjs`, so `COMETSCOUT_LLM_FAKE` (tests only) works.

## 1. Label sets
- A label set lives in `data/evals/<set>/`: `sample.json` (the chosen job files with their front matter and full text, frozen at sampling time) and `labels.jsonl` (one line per labelled job: `{ file, surface: "yes"|"no"|"unsure", reason, failure_mode?, labeler, labelled_at }`). JSONL so a crash never loses earlier labels and two sets can be merged.
- `node cli.mjs evals sample --set <name> [--size 70] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--seed N]`: a stratified sample from `data/decoded` and `data/rejected` across the verdicts (worth applying, held, weak, gate rejects, unreadable), so rare verdicts are represented; an option to force-include named files. Same seed, same sample.
- The sample stores each job's text only. The system verdict is read from the queue file at eval time, never shown while labelling.

## 2. The labelling screen (workspace)
- A "Label" view (`/label?set=<name>`): one job at a time, the job text as the decoder saw it (title, company, location, the description), never the verdict, gates or decoder notes. Three buttons, Yes / No / Unsure ("should I have seen this as worth applying to?"), a one-line reason (optional for Yes and No, required for Unsure: which fact is missing), and keyboard shortcuts (Y, N, U, Enter to save and go on, arrow keys to move). Progress (12 of 70), skip, go back and change, resume where you stopped.
- A rubric panel (collapsible) from `profile/eval-rubric.md` when the user has one, so the question is judged against the user's own criteria; the onboarding can draft it from `profile/profile.md`.
- Saving appends to `labels.jsonl` (a changed label appends a new line; the latest line per file wins). The API follows the workspace rules (header check, validation, run lock not required: labelling never touches the queue).
- Works on a phone screen too, but the copy says labelling is best done in one focused sitting.

## 3. `evals/decode.mjs` (`node cli.mjs evals decode --set <name> [--system queue|replay] [--compare <other>]`)
- System `queue`: the verdicts already in the queue files. System `replay`: decode the sampled jobs again now with the current decoder and prompt (dry run, results to `data/evals/<set>/replay-<date>.json`), with decoder history cut at each job's own date so no later outcome leaks in.
- Report (`data/evals/<set>/report-<date>.md` + JSON): confusion table (surfaced = strong-fit or investable-stretch vs the label), surfaced precision and recall with counts, the "missed good roles" list (label yes, not surfaced) and the "noise" list (label no, surfaced), each with the user's reason; gate correctness (gate rejects the user labelled yes); unsure labels kept out of the rates and counted separately; fact-flag counts.
- `--compare`: two systems on the same labelled jobs: both confusion tables, the jobs where they disagree, and which one the label agreed with (paired counts, plus an exact McNemar p-value).
- An imported system: `--system file:<path>` reads `{ file: verdict }` JSON, so a user can compare CometScout with any other pipeline they ran.

## 4. `evals/pack.mjs` (`node cli.mjs evals pack --a <dir> --b <dir> [--judge-model ...]`)
Blind A/B judge for application packs on the same jobs: for each job, the two CVs (and answers) are shown to a model judge in random order with the job text and the user's profile, and it picks the better one for this job with a short reason, or "tie"; every pair is judged twice with the order swapped, and a pair counts only when both orders agree. Report: wins, ties, inconsistent pairs, and the reasons. Lint failures (`lib/lint.mjs`) are reported separately: a pack that breaks a fact rule loses.

## 5. `evals/voice.mjs` (`node cli.mjs evals voice --dir <packs>`)
Does generated text sound like the user? A model judge gets `profile/voice.md` and the user's own writing samples (`profile/voice-samples/*.md`), then each generated cover letter and answer, and scores 1-5 with the phrases that sound least like the user. Report: mean, distribution, the worst five with phrases. Banned phrases from the lint rules are counted too.

## Docs
README "Evals" section: what each eval answers, how to make a label set and label it (about 70 jobs, one sitting, verdicts hidden), how to read the reports, and a warning not to tune the prompt on the same labels you report on (keep a held-out set). ROADMAP: M3 tooling done; the maintainer's own numbers come later.

## Tests
Sampling is stratified and deterministic by seed; the labelling API appends, the latest label wins, the job text served has no verdict, gate or decoder note; decode eval on a synthetic set with known labels gives the expected confusion table, precision and recall, missed and noise lists; replay passes a history cutoff (no outcome after the job date reaches the prompt); compare gives the expected paired counts and McNemar value; pack eval with the fake model: order swap, disagreement counted as inconsistent, lint loser; voice eval aggregates; Russian labels exist.

## Done when
`npm test` passes on Linux and Windows; `node cli.mjs doctor` runs on the example profile; the Label view works in a browser on demo data; docs updated. PR description lists what was built, what was not, and open questions.
