# 18: Transcription module (CPU, optional)

## Why
The interview coach's strongest workflow is `analyze`: it scores a real interview from its transcript. Most users record their calls (a phone recorder, Zoom, Meet, a desktop app) but have no easy way to turn a one-hour recording into a transcript without uploading the audio to a cloud service. CometScout runs on the user's own server, so it can transcribe there: private, free after setup, and fast enough on a normal 4-core VPS for a few hours of audio a week.

Maintainer decision (D06, changed 2026-10-06): the reference setup transcribes on the server CPU, because that is what a typical user has. A GPU worker stays a documented option, not built here.

Read `DEVELOPMENT.md` first. Plain Node 20 for CometScout itself, no new npm dependencies. The speech model runs in its own Python environment installed by the module script (like the coach module installs its own upstream), never vendored. Synthetic data only, no em dashes in user-facing text, English and Russian labels. Every change gets a test; `npm test` must pass on Linux and Windows without Python (tests use a fake transcriber).

## 1. Install: `deploy/modules/transcribe.sh` (and `transcribe.ps1`)
- Creates a Python virtual environment next to the home (default `<home>/../cometscout-transcribe`, or `modules.transcribe.path`) and installs `faster-whisper` from PyPI into it (pinned version, recorded). Needs `python3` and `python3-venv`; says how to install them when missing.
- Does not download a model at install time; the first job downloads the configured model into the module folder and says so (sizes: small about 0.5 GB, medium about 1.5 GB, large-v3 about 3 GB).
- Settings: `modules.transcribe: { "enabled": false, "path": null, "model": "medium", "compute_type": "int8", "threads": 2, "nice": 10, "language": null, "inbox": "data/audio/inbox", "keep_audio_days": 30 }`. `language: null` means detect; `"ru"` or `"en"` fixes it.
- `doctor`: when enabled, the venv exists, the faster-whisper version, the model cached or not (with size), `ffmpeg` on the PATH (needed for most audio formats), free disk for the model.

## 2. `cli.mjs transcribe`
- `node cli.mjs transcribe <file>`: one file now. `node cli.mjs transcribe --queue`: every file in the inbox, oldest first, one at a time.
- Runs the module's small Python script (`deploy/modules/transcribe/transcribe.py`, part of this repo: reads one audio file, writes JSON segments with start, end, text, and the detected language) under `nice` (and `ionice` where available) with `threads` CPU threads, so the rest of CometScout stays responsive. One job at a time across the machine (its own lock, separate from the run lock).
- Output in `data/transcripts/<date>--<name>/`: `transcript.md` (timestamps every paragraph, the language, the duration, the model, the time it took), `transcript.srt`, `segments.json`. The audio moves to `data/audio/done/` and is deleted after `keep_audio_days`.
- Speaker labels: not in this task (diarization needs extra models and an account token). The transcript says "speakers not separated"; the coach can still analyze it. Listed as a later option.
- When the coach module is enabled, the transcript is also copied to the coach's `materials/transcripts/` and the next `coach-handoff` lists the new transcripts ("ready for analyze").
- Failure: the audio stays in the inbox with a `.failed` note; the failure alert path (`notify`) tells the user once.
- `node cli.mjs transcribe --bench <file> [--models small,medium,large-v3]`: transcribes a sample with each model and prints the time, the real-time factor (processing time / audio length) and peak memory, so a user can pick the model for their server.

## 3. Getting audio in
- Drop files into the inbox (scp, Syncthing, rsync).
- Workspace: an upload button (multipart streamed to disk, size limit `modules.transcribe.max_upload_mb`, default 500), with the queue status (waiting, transcribing, done, failed).
- Telegram bot: an audio file, voice message or document sent to the bot goes to the inbox (the Bot API only lets bots download files up to 20 MB, so the bot answers with the upload alternatives for bigger files).
- A systemd path unit (`cometscout-transcribe.path`, installed by `cli.mjs timer` when the module is enabled) starts `transcribe --queue` when a file lands in the inbox.

## Docs
README "Transcription (optional)" section: what it does and does not do (no speaker separation yet), privacy (audio never leaves the server), the benchmark command, typical speed on a 4-core VPS as a range with the note to run `--bench`, disk needs, how the coach uses the transcripts. INSTALL and the Russian guide: one optional step. ROADMAP row.

## Tests
With a fake transcriber (`COMETSCOUT_TRANSCRIBE_CMD` pointing at a Node script that writes canned segments): one file and queue mode, one at a time (a second run waits or exits), outputs (md, srt, json) and their content, audio moved and pruned after `keep_audio_days`, failure path (`.failed` note, one alert), coach copy and hand-off listing, the bench report math, the upload API (size limit, path safety), the bot taking a small audio file and refusing a large one with the alternatives, doctor lines, Russian labels. The Python script gets a syntax check only when python3 is present.

## Done when
`npm test` passes on Linux and Windows; on a machine with Python, `bash deploy/modules/transcribe.sh` then `node cli.mjs transcribe --bench <a short sample>` works (say in the PR what you ran it on and the numbers); docs updated. PR description lists what was built, what was not, and open questions.
