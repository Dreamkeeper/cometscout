# 20: Russian transcription: GigaAM, a targeted merge with Whisper, and a glossary from the user's own data

## Why
Whisper large-v3-turbo (the default since task 18) is good across languages, but on a real 56-minute Russian interview it flipped meanings ("I see it" for "I don't see it"), invented words and left long stretches without punctuation. Sber's GigaAM v3 (MIT) is clearly better on Russian and about four times faster on CPU (about 11 minutes per audio hour on 2 threads), but it garbles English words inside Russian speech, which job interviews are full of: "roadmap", "B2B SaaS", "Zigbee", "Philips Hue", product and company names. The two engines make different errors, so a targeted merge wins: GigaAM's Russian text and punctuation as the base, and Whisper's word only where Whisper heard a Latin-script term or a number at the same moment. A private prototype on real recordings confirmed it: 29 good substitutions in 56 minutes, mostly English terms and brands.

What neither engine nor the merge fixes is the user's own vocabulary: company names, product names, internal terms (an employer's name heard as a similar-sounding Russian word, an acronym spelled with the wrong letters, a product category garbled into a non-word). CometScout already knows most of these words, from the user's applications, profile and CV library. A glossary built from them, given to Whisper as hint words and matched against GigaAM's output by sound, targets exactly those errors. A generic transcriber cannot do this.

Maintainer decision (D51): Russian recordings go to GigaAM plus a Whisper merge plus the glossary; other languages stay on Whisper. Doubtful words are highlighted for review, never changed silently.

Read `DEVELOPMENT.md` and task 18 first. Plain Node 20, no new npm dependencies; the speech models run in the module's Python venv. Synthetic data only in the repository (never real recordings or transcripts), no em dashes in user-facing text, English and Russian labels. Every change gets a test; `npm test` must pass on Linux and Windows without Python (fake engines).

## 1. Engines and routing
- `modules.transcribe.engines`: `{ "ru": "gigaam+whisper", "default": "whisper" }`. Allowed values: `whisper`, `gigaam`, `gigaam+whisper`. `language` (task 18) still forces a language; otherwise the language is detected with Whisper's language detection on the first 30 seconds (fast; reported with its probability), and the engine for that language is used.
- GigaAM: model `v3_e2e_rnnt` (not ctc: no faster, and it glues words). Installed as an optional extra by the module installer (`transcribe.sh --with-gigaam`, and asked in the onboarding when the user's profile or language says Russian): the `gigaam` package pinned, PyTorch CPU-only pinned from the PyTorch CPU index (no CUDA wheels; say the download size), within the existing constraints file and its Python markers. Check which Python versions have CPU torch wheels and set the extra's minimum accordingly; doctor says when the extra is missing or the Python is too old for it.
- Long audio without an account: GigaAM's own long-form mode uses pyannote, whose models need a Hugging Face account and accepting terms. Do not use it. Cut speech segments with the Silero VAD that faster-whisper already ships (`faster_whisper.vad`), group them into chunks of at most about 25 seconds at silences, and run GigaAM per chunk with word timestamps, offsetting times back to the file.
- `transcribe.py` gains `--engine whisper|gigaam`, writes the same JSON shape for both (segments with words: text, start, end, probability where the engine gives one) plus the engine, model and timings.

## 2. The merge (`lib/transcribe-merge.mjs`, pure Node)
Inputs: GigaAM words and Whisper words with times. Output: merged words and segments, plus a list of substitutions and review items.
- Align the two word sequences within overlapping time windows (dynamic programming on lowercase forms with a Cyrillic to Latin transliteration, so "роадмап" ~ "roadmap"), split at hyphens and decide word by word.
- Keep GigaAM's word, except: replace it with Whisper's when Whisper's aligned word is Latin-script (or an abbreviation) and GigaAM's is a transliteration or garble of it (similarity thresholds as in the prototype: replace above about 0.45 transliterated similarity, require higher similarity and Whisper probability above about 0.85 for short words); Latin vs Latin pairs use the same thresholds; a Cyrillic word that is a Cyrillic look-alike of a Latin code ("Е27" with a Cyrillic Е) becomes the Latin form.
- Numbers: replace a spelled number with Whisper's digits only when the values match exactly, the value is 10 or more, and an ordinal keeps its suffix.
- A short built-in list of Russian brand names that stay in Cyrillic (Сбер, Яндекс, Алиса and their case forms), extendable from settings.
- Keep GigaAM's punctuation; build subtitle segments from GigaAM's sentence punctuation and pauses (target 2 to 8 seconds, never more than about 12).
- Review items: Cyrillic words where the engines disagree, Whisper's word is confident, and GigaAM's word is not a known word (a small frequency word list is not needed: use "Whisper confident and the glossary or the other engine supports it"). They are listed, never applied.
- Port the logic from the maintainer's private prototype description above; write it fresh with synthetic tests. No real transcripts in the repository.

## 3. The glossary (`lib/transcribe-glossary.mjs`)
- Built automatically before each job from the user's own data: company names (and aliases) from `data/state/applications.json` and the queue files of the last 90 days, product and technology names from the CV library (`profile/cv-library.json`: titles, skills, product names) and `profile/profile.md` (capitalised terms, Latin-script terms, acronyms), plus `profile/glossary.txt` (one term per line, optional `term = spoken form` pairs such as `KPI = кейпиай`), plus `modules.transcribe.glossary` in settings. Deduplicated, capped (about 200 terms, most frequent and most recent first), written next to the transcript as `glossary-used.txt`.
- Whisper: the terms are passed as `hotwords` (faster-whisper's parameter) for Whisper runs.
- GigaAM: after the merge, a GigaAM word or two-word span that matches a glossary term by sound (transliterated similarity above a high threshold, length-aware, and not a common Russian word in the glossary's own exclusions) is replaced with the glossary spelling, and the change is listed as a substitution with source "glossary".
- Never sent anywhere: the glossary is built and used on the server only.

## 4. Outputs
- `transcript.md` header says the engines, the detected language and its probability, the glossary size, and counts of substitutions and review items. The text is the merged text. At the end, a "Check these words" section lists review items with times (GigaAM word, Whisper word), so the user or the coach can fix them; a "Changes made" section lists substitutions (time, before, after, source: whisper or glossary).
- `segments.json` keeps per-word source (gigaam, whisper, glossary). The SRT is the merged text.
- The coach hand-off and the Telegram attachment use the merged transcript.

## 5. Bench
`--bench` accepts `--engines whisper,gigaam,gigaam+whisper` and prints time per audio hour for each; with `--reference <text file>` it also prints WER (lowercase, punctuation stripped, ё as е).

## Docs
README: the Russian path, what the merge does and does not do, the glossary and `profile/glossary.txt`, the extra's size, measured speeds (run the bench on a public Russian sample, for example Russian LibriSpeech from the Hugging Face datasets server, and on English; put the machine and numbers in the README and the PR). Russian guide: the same, short. ROADMAP.

## Tests
With fake engines (`COMETSCOUT_TRANSCRIBE_CMD` serving canned word lists per engine): routing by detected and forced language; the merge on synthetic examples (a transliterated English term replaced, a correct Russian word kept, a hyphenated word split and decided per part, numbers rule incl. below 10 and ordinals, brand keep-list, Latin look-alike code, punctuation and segment building); glossary building from synthetic applications, CV library and profile, its cap and order, hotwords passed to the Whisper call, the sound match on GigaAM output and its threshold; review items listed but not applied; outputs (md sections, segments sources); installer extra with a fake pip (torch from the CPU index, pins); doctor lines; Russian labels.

## Done when
`npm test` passes on Linux and Windows; on a machine with Python, the extra installs and `--bench --engines gigaam,gigaam+whisper` runs on a public Russian sample (numbers in the PR); docs updated. PR description lists what was built, what was not, and open questions.
