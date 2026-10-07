# 21: Speaker separation (optional): who said what, and which speaker is the user

## Why
A transcript without speakers is hard to coach from: the interview coach scores the candidate's answers, so it has to know which lines are the candidate's and which are the interviewer's questions. Today the user has to work that out by reading. Speaker separation (diarization) labels every line with a speaker, and with one short sample of the user's own voice, CometScout can label the user's lines "Me" automatically.

Maintainer decisions (D52, D53): no pyannote models (they need a Hugging Face account and accepting terms); use sherpa-onnx with a converted pyannote segmentation model (MIT) and a speaker-embedding model, both downloaded from k2-fsa's GitHub releases with no account. Optional, off by default.

Read `DEVELOPMENT.md` and tasks 18 and 20 first. Plain Node 20, no new npm dependencies; the models run in the module's Python venv. Synthetic data only in the repository, no em dashes in user-facing text, English and Russian labels. Every change gets a test; `npm test` must pass on Linux and Windows without Python (a fake diarizer).

## 1. Install
- `transcribe.sh --with-speakers` (and `.ps1`): `sherpa-onnx` pinned in the constraints file (check wheels for Python 3.10-3.14 on Linux x86_64/aarch64 and Windows x64, with markers if needed), plus the models from k2-fsa's GitHub releases, each with a pinned URL and sha256: `sherpa-onnx-pyannote-segmentation-3-0` and one embedding model (default NeMo TitaNet-small, or a 3D-Speaker model if the bench below shows it is clearly better on two-speaker calls; record the licence of each in the README).
- Settings: `modules.transcribe.speakers: { "enabled": false, "embedding": "titanet-small", "num_speakers": null, "min_speakers": 2, "max_speakers": 4, "threshold": null, "me_sample": "profile/my-voice.wav", "me_threshold": null }`. `num_speakers: 2` when the user knows it is a one-to-one call.
- doctor: extra installed or not, models present with their sha256, the sample present and long enough.

## 2. Pipeline
- Run diarization once on the whole file (sherpa-onnx offline speaker diarization) after transcription: speaker turns with start and end.
- Assign every word (from Whisper, GigaAM or the merge of task 20) to the speaker whose turn overlaps it most; a word on a boundary goes to the turn holding its midpoint. Segments and SRT cues break at speaker changes.
- "Me": when `me_sample` exists (about 20-60 s of the user speaking alone, any language), embed it once (cached by file hash), embed each speaker's longest clean turns, and label the speaker with the closest embedding "Me" when the similarity is above the threshold (calibrate the default on the bench); otherwise all speakers stay "Speaker 1", "Speaker 2". Never label two speakers "Me".
- Renaming: `speakers.json` next to the transcript maps labels to names; `node cli.mjs transcribe --rename <transcript folder> "Speaker 2=Interviewer"` (and a small form in the workspace's transcript view) rewrites the md and srt from `segments.json`.
- Overlapping speech: words keep one speaker; the md marks a line where two turns overlap by more than about 1 s.

## 3. Outputs and the coach
- `transcript.md`: `**Me:** ...` / `**Speaker 2:** ...` paragraphs; the header gives the number of speakers found, whether "Me" was identified and with what similarity, and the diarization time. SRT cues prefixed with the speaker. `segments.json` gets a speaker per word and segment.
- Coach hand-off: transcripts with speakers say so ("Me" = the candidate), so `analyze` can score the candidate's answers directly.

## 4. Bench
`node cli.mjs transcribe --bench-speakers [--embeddings titanet-small,3dspeaker] [--lang en|ru]` builds synthetic two-speaker conversations from public read speech with known speakers (for example LibriSpeech test-clean and Russian LibriSpeech, downloaded through the Hugging Face datasets server; never committed): alternating turns of 3-20 s, short pauses, a few short overlaps, two different speakers per mix; then reports DER (missed speech, false alarm, confusion; collar 0.25 s), the "Me" identification accuracy with one speaker's other utterances as the sample, and CPU time per audio hour. Put the numbers and the machine in the README and the PR.

## Docs
README "Speakers (optional)" section: what it does, the voice sample (how to record it, that it stays on the server), renaming, the cost, the licences, limits (similar voices, more than four speakers, heavy overlap). Russian guide: short. ROADMAP.

## Tests
With a fake diarizer and fake embeddings (`COMETSCOUT_TRANSCRIBE_CMD`): word assignment (overlap, midpoint rule), segment breaking at speaker changes, "Me" identification above and below the threshold and never twice, renaming rewrites md and srt, overlap marks, outputs and header, coach hand-off text, installer extra with a fake pip and fake downloads (sha256 checked, a wrong hash refused), doctor lines, the synthetic-mix builder and the DER computation on hand-made turns, Russian labels.

## Done when
`npm test` passes on Linux and Windows; on a machine with Python the extra installs and `--bench-speakers` runs for English and Russian (numbers in the PR); docs updated. PR description lists what was built, what was not, and open questions.
