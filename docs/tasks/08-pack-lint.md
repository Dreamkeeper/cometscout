# 08: Lint rules from the profile for packs (CV, cover letter, answers)

## Why
A pack is only useful if it never puts a false claim in front of a recruiter. Today `pack/pack.mjs` checks the model-written texts against `profile/fact-rules.json` plus two universal rules (em dash, third person). The original pipeline lints the rendered CV document against the user's own rules file, falls back to vetted text when a rule fires, and refuses to deliver a CV that still breaks a rule. Users add a rule every time they correct a fact, so the rules file is the user's memory of what must never be written.

Read `DEVELOPMENT.md` first. Plain Node 20, no new dependencies, synthetic data only, no em dashes in user-facing text. Every change gets a test that fails on the current code.

## Rules file: `profile/lint-rules.json` (optional)
```json
{
  "banned_claims": [ { "id": "first-pm", "pattern": "\\bfirst (product )?(pm|product manager)\\b", "why": "Not the first PM at either company." } ],
  "warn_claims":   [ { "id": "fluff", "pattern": "\\b(passionate|synergy)\\b", "why": "Empty words." } ],
  "limits": { "bullet_max_words": 70, "summary_max_words": 190 }
}
```
All keys optional. Patterns compile with flags `giu`; a pattern that does not compile is reported by `doctor` and skipped. `banned_claims` are errors, `warn_claims` and limits are warnings. Add a commented example to `profile.example/lint-rules.json` (two banned, two warn rules, synthetic).

## Build `lib/lint.mjs`
- `paragraphsFromXml(xml)`: WordprocessingML to `[{ text, kind, words }]`. Text is the joined `<w:t>` runs, entities decoded, whitespace collapsed; empty paragraphs dropped. Kind: `bullet` when the paragraph has `<w:numPr>`; `heading` when bold (`<w:b/>`), not a bullet and under 140 characters; `summary` when over 60 words; else `line`.
- `lintParagraphs(paras, rules)` returns `{ errors, warns, info }`: each hit `{ id, para, kind, match, why, text }` (text cut to 120 chars), one hit per rule per paragraph; `bullet-length` and `summary-length` warnings from the limits; `info` one line (paragraphs, bullets, longest bullet, summary words).
- `lintDocumentXml(xml, rules)` and `lintText(text, rules)` (plain text, split on blank lines, kind `line`, for cover letters and answers).
- `formatReport(result, label)` for the CLI and `answers.md`.
- CLI: `node lib/lint.mjs <file.docx|document.xml|file.txt> [--json]` exits 1 on errors (unzip the docx with the same Python helper `pack/pack.py` already relies on, or a tiny zip reader in Node; no new dependency).

## Use it in `pack/pack.mjs`
1. After `renderCv`, lint the CV XML. On errors in model-written text (tagline or summary), replace both with the vetted versions (the existing fallback), re-render and lint again. Flag: `CV lint: <ids> in model text, vetted summary used`.
2. If errors remain, the vetted library itself breaks a rule: do not build the PDF or send the pack for this job; log `pack <file>: CV still breaks <ids> after the vetted fallback; fix profile/cv-library.json` and continue with the next job. The run's result lists it.
3. Cover letter and each answer: `lintText`; errors are flags under "Check before sending" (`Cover letter: <id> (<why>)`), warnings too, marked as warnings. Keep the existing fact-rule and universal checks; do not report the same hit twice.
4. `pack.json` gets `lint: { cv: {errors, warns}, cover_letter: [...], answers: [...] }`.

## `doctor`
- `lint rules: N banned, M warn` (or "none": optional), pattern errors listed.
- Lint the vetted library: every tagline, summary and bullet in `cv-library.json` through `lintText`; a banned hit there fails the check with the item id ("vetted text breaks your own rule").

## Tests
`test/lint.test.mjs`: paragraph kinds on a synthetic document.xml (bullet, bold heading, long summary), entity decoding, one hit per rule per paragraph, limits, `giu` (Cyrillic case-insensitive), bad pattern skipped. Pack-level: inject the model call (see how pack tests or the decoder tests stub `callJson`; add a seam if needed) and check the fallback path, the refuse path, and flags for cover letter and answers.

## Done when
`npm test` passes; `doctor` runs on the example profile; README section "Lint rules" (what the file is, that every corrected fact should become a rule, that a banned hit in vetted text stops the pack); ROADMAP row updated. PR description lists what was built, what was not, and open questions.
