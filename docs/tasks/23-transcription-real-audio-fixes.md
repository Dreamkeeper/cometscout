# 23: Transcription on real recordings: glossary, merge, speakers, missed speech, honest reports

## Why
Tasks 18 to 21 were tuned on public read speech and synthetic two-speaker mixes. A private run on real Russian work recordings (2026-10-07: an office meeting of about an hour with 3 people, and a phone call of about 6 minutes with 2 people) worked end to end but showed six problems. The transcripts feed the interview coach, so a wrong product term or a phantom speaker makes the coach's analysis worse.

Read `DEVELOPMENT.md` and `CLAUDE.md` first. Plain Node and the module's Python; no new dependencies unless a fix cannot be done without one (say why in the PR). Every change gets a synthetic test; `npm test` must pass on Linux and Windows.

## Privacy (binding)
- The real recordings are named only in your task prompt. Read them from there; never copy them, their transcripts, names, phone numbers or any line of their text into the repository, a commit, a PR, an issue, a test fixture or a CI log.
- Put every private output (transcripts, diarization, timings, your notes) in a temporary folder outside the repository, and delete the transcripts when you are done.
- What may go public: numbers (thresholds, counts, error rates, timings), and synthetic examples that show the same failure. Write the before/after evaluation as counts only.

## 1. The glossary replaces ordinary words
The glossary built automatically from the user's own data (`lib/transcribe-glossary.mjs`) turned a common Russian phrase meaning "product manager" into the English word "Products": terms taken from the CV library were applied as if every sound-alike were a mistake.
Fix: automatic terms are names, not vocabulary. Take only proper-noun-like terms (brand and product names, Latin-script words, words with capitals or digits, multi-word names); never a common word of either language (use a stoplist of frequent Russian and English words, and refuse a term whose replacement would turn a common word into another word). A replacement needs a strong sound match on a whole word. Terms the user wrote into the glossary by hand keep working as before. Test with synthetic text that has the same shape.

## 2. Whisper's Latin-script words beat the glossary
Where Whisper heard an English-looking word, the merge kept it even when the glossary named the right one (a Russian pronunciation of the brand "Aqara" came out as "Takara"). The output also had words that mix Latin and Cyrillic letters, and one word twice in a row at a merge seam.
Fix: match the glossary against Whisper's Latin words too (sound-alike across scripts), so a near miss becomes the glossary term; never emit a token that mixes scripts (pick one side of the merge instead); drop an immediate repeat of the same word that the merge itself created. Tests.

## 3. Russian glossary terms do not settle a disagreement
When GigaAM and Whisper disagree on a Cyrillic word and one variant is a glossary term (the right word for "dimmers" against a mishearing of it), the merge does not use the glossary to choose. Fix: prefer the variant that matches a glossary term, Cyrillic or Latin; with no glossary match, keep today's rule. Tests.

## 4. Too many speakers
Speaker separation found 4 speakers in both recordings (3 and 2 people talked). The clustering thresholds came from the synthetic bench (`lib/transcribe-speakers.mjs`, `transcribe.py --diarize`).
Fix: (a) merge any cluster with too little speech (below a minimum total duration and share of the recording, to be calibrated) into its nearest cluster by embedding distance, and say so in the transcript header; (b) recalibrate the clustering threshold and that minimum on the real recordings privately, and check the synthetic bench (`--bench-speakers`) does not get worse; (c) keep `min_speakers` and `max_speakers` working. Only the calibrated numbers go into the code, with the date and "calibrated on 2 real recordings" in a comment.

## 5. Possibly missed speech
About 50 seconds near the start of the long recording (roughly minute 2) may be missing from the transcript. Check it privately: compare the voice-activity segments (Silero) with the audio energy and with Whisper's own output for that span. If speech is dropped, find the cause (voice-detection threshold or padding, chunking, a decoder setting that skips low-confidence spans) and fix it; add a check that warns in the transcript header when a long span with speech-like energy produced no text. Tests with a synthetic gap.

## 6. Reports that do not match what happened
- The transcript header's timing leaves out speaker separation: include every stage, and the total.
- The README says Whisper large-v3-turbo peaks at about 1.9 GB; the private run measured 4.2 GB, while a 4-vCPU server bench on 2026-10-15 measured 1.7 to 2.1 GB. Find what drives the difference (threads, engines loaded together, the merge holding both models, speaker separation) and state the peak per configuration.
- `transcribe` says "the first use downloads it" even when the model is already on disk: say it only when it really downloads.
- The README bench table: add a row group for a 4-vCPU server (AMD EPYC 9575F, 2026-10-15, Russian speech, speed only): Whisper large-v3-turbo real-time factor 0.24 to 0.26 at 2 threads and 0.17 to 0.18 at 4; GigaAM 0.05 to 0.07; the GigaAM and Whisper merge 0.33 at 2 threads and 0.22 at 4; small 0.12 to 0.16; peak memory under 2.1 GB. Remove the claim that a 4-vCPU VPS is usually slower per thread than the laptop; say instead that it depends on the host and to run `--bench`.

## Done when
One PR (or one per area if it grows large) with tests for every fix, green CI, and a private evaluation summary in counts only in the PR description: speakers found against true per recording, glossary replacements of common words (before and after), mixed-script tokens, repeated words, the missed-speech span (found or not, and why), the synthetic speaker bench before and after.
