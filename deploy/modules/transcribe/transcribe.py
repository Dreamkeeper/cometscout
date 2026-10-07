#!/usr/bin/env python3
"""CometScout transcription module: one audio file in, JSON segments out.

Runs inside the module's own virtual environment, where deploy/modules/transcribe.sh installed faster-whisper (and,
with --with-gigaam, GigaAM and a CPU-only PyTorch). CometScout (lib/transcribe.mjs) starts it under nice and ionice,
picks the engine for the language and merges the two engines' words; this script only transcribes.

  python transcribe.py --out result.json [--engine whisper|gigaam] [--words] [--hotwords TEXT]
                       [--engines JSON] [--language-floor 0.6] [--language-fallback auto|ru]
                       [--model large-v3-turbo] [--compute-type int8] [--threads 2] [--language ru]
                       [--models-dir DIR] [--vad silero] [--vad-options JSON] [--gigaam-model v3_e2e_rnnt] AUDIO

Writes {"engine", "language", "language_probability", "duration", "model", "compute_type", "threads", "vad",
        "chunks", "forced_cuts", "load_seconds", "transcribe_seconds", "peak_rss_mb",
        "segments": [{"start", "end", "text", "words": [{"text", "start", "end", "probability"}]}]}
  Whisper writes words only with --words (word timestamps cost a little time); GigaAM always writes them and gives no
  probability. GigaAM is Russian only: its language is "ru".
--engines (Whisper, no --language): the engine per language ({"ru": "gigaam+whisper", "default": "whisper"}). The same
  process first detects the language on the first 30 seconds of speech (the Silero VAD, so silence and hold music at the
  start do not decide it), then routes: under --language-floor the detection is unsure and --language-fallback decides
  ("auto": Whisper alone, detecting on its own over the file; a language code: that language). It writes what it found
  ({"mode": "detect", "detected": {"language", "probability", "speech_seconds", "floor", "fallback"}, "route":
  {"language", "engine", "sure"}}) before transcribing, so the caller keeps it when the transcription fails. A language
  that goes to GigaAM alone stops there; otherwise the same loaded model transcribes (with word times for
  "gigaam+whisper") and the result carries "detected", "route", "detect_seconds" and "mode": "transcribe".
Progress goes to stderr. Exit 0 on success, 2 on a usage error, 1 on any other failure (the reason on stderr).
Models are downloaded into --models-dir on first use: Whisper from Hugging Face (small about 0.5 GB, large-v3-turbo
1.6 GB), GigaAM from Sber's model server (v3_e2e_rnnt about 0.45 GB, into <models-dir>/gigaam).
Long audio for GigaAM is cut with the Silero VAD that faster-whisper ships (no account, no pyannote; --vad-options:
threshold, min_silence_duration_ms, speech_pad_ms, tuned for cutting rather than faster-whisper's defaults, whose 2 s
minimum silence gives a few very long segments), grouped into chunks of 15 to 22 seconds (never more than 25) cut only
at pauses where there are any ("forced_cuts" counts the cuts made inside speech), and each chunk's word times are moved
back to the file's time.
"""
import argparse
import json
import math
import os
import sys
import time

SAMPLE_RATE = 16000
CHUNK_MIN_S, CHUNK_MAX_S, CHUNK_HARD_S = 15.0, 22.0, 25.0   # GigaAM's own limit for one pass is 25 s
VAD_DEFAULTS = {"threshold": 0.4, "min_silence_duration_ms": 400, "speech_pad_ms": 250}
DETECT_SPEECH_S = 30.0  # the language is detected on this much speech
DETECT_SCAN_S = 120.0   # audio is searched for it in pieces of this length, so a long file is not scanned whole
LANGUAGE_FLOOR = 0.6
GIGAAM_BATCH = 1        # chunks per forward pass: batching gave no speed on the CPU (measured), only memory


def log(text):
    print(text, file=sys.stderr, flush=True)


def peak_rss_mb():
    """Peak resident memory of this process in MB, or None where it cannot be read."""
    try:
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # KB on Linux, bytes on macOS
        return round(peak / 1024 / (1024 if sys.platform == "darwin" else 1), 1)
    except ImportError:
        pass
    try:
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                                                     "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                                                     "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]

        kernel32, psapi = ctypes.windll.kernel32, ctypes.windll.psapi
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        if psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            return round(counters.PeakWorkingSetSize / 1048576, 1)
    except Exception:
        pass
    return None


def allow_newer_pyav():
    """faster-whisper 1.2.1 passes metadata_errors to av.open, which PyAV 15 and newer no longer take. Newer Python
    versions only have wheels for those PyAV versions, so the argument is dropped when PyAV refuses it."""
    try:
        import av
    except ImportError:
        return
    original = av.open

    def open_compat(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        except TypeError as e:
            if "metadata_errors" not in kwargs or "metadata_errors" not in str(e):
                raise
            kwargs.pop("metadata_errors")
            return original(*args, **kwargs)

    av.open = open_compat


def write_json(path, result):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(tmp, path)


# ---------- voice activity: a list of speech segments, from whichever VAD the setting names ----------
def silero(audio, options, offset=0.0):
    """Speech segments [(start, end)] in seconds, from the Silero VAD bundled with faster-whisper."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    opts = VadOptions(threshold=float(options["threshold"]), min_silence_duration_ms=int(options["min_silence_duration_ms"]),
                      speech_pad_ms=int(options["speech_pad_ms"]))
    return [(offset + s["start"] / SAMPLE_RATE, offset + s["end"] / SAMPLE_RATE) for s in get_speech_timestamps(audio, opts)]


def vad_silero(audio, options):
    """(speech, finer): the speech segments, and a function that finds the short pauses inside one long segment (the
    same VAD with a 100 ms minimum silence and little padding, then 50 ms and a stricter threshold) so it can still be
    cut at a pause."""
    levels = [dict(options, min_silence_duration_ms=100, speech_pad_ms=30),
              dict(options, min_silence_duration_ms=50, speech_pad_ms=20, threshold=max(float(options["threshold"]), 0.6))]

    def finer(start, end):
        region, best = audio[int(start * SAMPLE_RATE):int(end * SAMPLE_RATE)], [(start, end)]
        for opts in levels:
            sub = silero(region, opts, offset=start)
            if len(sub) > len(best):
                best = sub
            if sub and all(b - a <= CHUNK_HARD_S for a, b in sub):
                break
        return best

    return silero(audio, options), finer


VADS = {"silero": vad_silero}   # each returns (speech segments, finer); the chunking below works with any of them


def chunk_speech(speech, finer=None, min_s=CHUNK_MIN_S, max_s=CHUNK_MAX_S, hard_s=CHUNK_HARD_S, depth=0):
    """Speech segments [(start, end)] into chunks for GigaAM: (chunks, forced_cuts). A chunk ends between two segments
    (at a pause) and runs up to max_s seconds, or up to hard_s when it would otherwise stay under min_s; a scrap under
    2 seconds joins its neighbour. A segment longer than hard_s is first split at the short pauses `finer` finds inside
    it (twice at most); only speech with no pause at all is cut into equal parts, and each of those cuts counts as forced."""
    segs, forced = [], 0
    for start, end in speech:
        if end <= start:
            continue
        if end - start <= hard_s:
            segs.append((start, end))
            continue
        inner = [(max(start, a), min(end, b)) for a, b in (finer(start, end) if finer else []) if min(end, b) > max(start, a)]
        if len(inner) > 1:
            sub, f = chunk_speech(inner, finer if depth < 1 else None, min_s, max_s, hard_s, depth + 1)
            segs.extend(sub)
            forced += f
            continue
        parts = math.ceil((end - start) / max_s)
        step = (end - start) / parts
        segs.extend((start + k * step, start + (k + 1) * step) for k in range(parts))
        forced += parts - 1
    chunks, i = [], 0
    while i < len(segs):
        start, j = segs[i][0], i
        while j + 1 < len(segs) and segs[j + 1][1] - start <= max_s:
            j += 1
        if segs[j][1] - start < min_s and j + 1 < len(segs) and segs[j + 1][1] - start <= hard_s:
            j += 1
        chunks.append((start, segs[j][1]))
        i = j + 1
    out = []
    for s, e in chunks:
        if e - s < 2 and out and e - out[-1][0] <= hard_s:
            out[-1] = (out[-1][0], e)
        elif out and out[-1][1] - out[-1][0] < 2 and e - out[-1][0] <= hard_s:
            out[-1] = (out[-1][0], e)
        else:
            out.append((s, e))
    return out, forced


# ---------- engines ----------
def load_audio(path):
    from faster_whisper.audio import decode_audio  # PyAV with its own FFmpeg libraries: no ffmpeg command needed
    return decode_audio(path, sampling_rate=SAMPLE_RATE)


def whisper_model(a):
    from faster_whisper import WhisperModel
    allow_newer_pyav()
    log(f"loading Whisper {a.model} ({a.compute_type}, {a.threads} threads); the first use downloads it")
    return WhisperModel(a.model, device="cpu", compute_type=a.compute_type, cpu_threads=max(1, a.threads),
                        download_root=a.models_dir)


def speech_window(speech, limit=DETECT_SPEECH_S):
    """The first `limit` seconds of speech from the VAD's segments [(start, end)], the last one cut short."""
    out, total = [], 0.0
    for start, end in speech:
        take = min(end - start, limit - total)
        if take <= 0:
            if total >= limit:
                break
            continue
        out.append((start, start + take))
        total += take
    return out


def choose_route(language, probability, engines, floor=LANGUAGE_FLOOR, fallback="auto"):
    """{"language", "engine", "sure"}: the engine for the detected language when the detection is at least `floor`
    sure; otherwise `fallback` decides: "auto" is Whisper alone with no language (it detects on its own), a language
    code is that language and its engine."""
    sure = probability is not None and probability >= floor
    lang = language if sure else (fallback if fallback and fallback != "auto" else None)
    if lang is None:
        return {"language": None, "engine": "whisper", "sure": False}
    return {"language": lang, "engine": engines.get(lang) or engines.get("default") or "whisper", "sure": sure}


def detect_speech_language(model, audio, vad_options):
    """(language, probability, seconds of speech used): Whisper's detection on the first 30 s of speech the Silero VAD
    finds, scanned in 2-minute pieces; the first 30 s of audio when there is no speech at all."""
    import numpy as np
    duration, spans, at = len(audio) / SAMPLE_RATE, [], 0.0
    while at < duration and sum(e - s for s, e in spans) < DETECT_SPEECH_S:
        end = min(duration, at + DETECT_SCAN_S)
        spans = speech_window(spans + silero(audio[int(at * SAMPLE_RATE):int(end * SAMPLE_RATE)], vad_options, offset=at))
        at = end
    clip = np.concatenate([audio[int(s * SAMPLE_RATE):int(e * SAMPLE_RATE)] for s, e in spans]) if spans else audio[: int(DETECT_SPEECH_S * SAMPLE_RATE)]
    language, probability, _ = model.detect_language(clip)
    return language, probability, sum(e - s for s, e in spans)


def run_whisper(a, started, model=None, audio=None, loaded=None):
    model = model or whisper_model(a)
    loaded = loaded or time.monotonic()
    segments, info = model.transcribe(audio if audio is not None else a.audio, language=a.language or None, vad_filter=True,
                                      word_timestamps=a.words, hotwords=a.hotwords or None)
    log(f"language {info.language} ({info.language_probability:.0%}), {info.duration:.0f} s of audio")
    out, next_note = [], 300.0
    for s in segments:  # the generator does the work as it is read
        seg = {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
        if a.words:
            seg["words"] = [{"text": w.word.strip(), "start": round(w.start, 2), "end": round(w.end, 2),
                             "probability": round(w.probability, 3)} for w in (s.words or []) if w.word.strip()]
        out.append(seg)
        if s.end >= next_note:
            log(f"{s.end / 60:.0f} of {info.duration / 60:.0f} min done")
            next_note += 300.0
    done = time.monotonic()
    return {"engine": "whisper", "language": info.language, "language_probability": round(info.language_probability, 3),
            "duration": round(info.duration, 2), "model": a.model, "compute_type": a.compute_type, "threads": a.threads,
            "load_seconds": round(loaded - started, 2), "transcribe_seconds": round(done - loaded, 2), "segments": out}


def run_auto(a, started):
    """--engines: detect the language on the first 30 s of speech, route it, and transcribe with the model already
    loaded, unless the language goes to GigaAM alone."""
    model = whisper_model(a)
    loaded = time.monotonic()
    audio = load_audio(a.audio)
    language, probability, speech = detect_speech_language(model, audio, a.vad_options)
    detected = time.monotonic()
    route = choose_route(language, probability, a.engines, a.language_floor, a.language_fallback)
    note = "" if route["sure"] else f", under {a.language_floor:.0%}: {route['language'] or 'Whisper detects it'}"
    log(f"language {language} ({probability:.0%}) from {speech:.0f} s of speech{note}; engine {route['engine']}")
    head = {"engine": route["engine"], "mode": "detect", "language": route["language"] or language,
            "language_probability": round(probability, 3), "model": a.model,
            "detected": {"language": language, "probability": round(probability, 3), "speech_seconds": round(speech, 1),
                         "floor": a.language_floor, "fallback": a.language_fallback},
            "route": route, "load_seconds": round(loaded - started, 2), "detect_seconds": round(detected - loaded, 2)}
    write_json(a.out, head)  # kept when the transcription below fails: the caller still knows the language
    if route["engine"] == "gigaam":
        return head
    a.language = route["language"]
    a.words = a.words or route["engine"] == "gigaam+whisper"
    result = run_whisper(a, started, model=model, audio=audio, loaded=detected)
    result.update(mode="transcribe", detected=head["detected"], route=route, load_seconds=head["load_seconds"],
                  detect_seconds=head["detect_seconds"])
    return result


def run_gigaam(a, started):
    try:
        import torch
        import gigaam
        from gigaam.utils import AudioDataset
    except ImportError as e:
        raise RuntimeError(f"GigaAM is not installed in this Python ({e}); run deploy/modules/transcribe.sh --with-gigaam")
    torch.set_num_threads(max(1, a.threads))
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass  # already set in this process
    root = os.path.join(a.models_dir, "gigaam") if a.models_dir else None
    log(f"loading GigaAM {a.gigaam_model} ({a.threads} threads); the first use downloads it (about 0.45 GB)")
    model = gigaam.load_model(a.gigaam_model, fp16_encoder=False, use_flash=False, device="cpu", download_root=root)
    loaded = time.monotonic()
    audio = load_audio(a.audio)
    duration = len(audio) / SAMPLE_RATE
    speech, finer = VADS[a.vad](audio, a.vad_options)
    chunks, forced = chunk_speech(speech, finer)
    log(f"{duration:.0f} s of audio, {len(speech)} speech segments in {len(chunks)} chunks ({a.vad} VAD, {forced} cut without a pause)")
    out, next_note = [], 300.0
    with torch.inference_mode():
        for i in range(0, len(chunks), GIGAAM_BATCH):
            batch = chunks[i:i + GIGAAM_BATCH]
            wavs = [torch.from_numpy(audio[int(s * SAMPLE_RATE):int(e * SAMPLE_RATE)].copy()) for s, e in batch]
            wav_pad, wav_lens = AudioDataset.collate(wavs)
            encoded, encoded_len = model.forward(wav_pad, wav_lens)
            # gigaam 0.2.0 (pinned): _decode is what transcribe_longform uses for word times per batch item
            for (s, e), (text, words) in zip(batch, model._decode(encoded, encoded_len, wav_lens, True)):
                ws = [{"text": w.text, "start": round(w.start + s, 2), "end": round(w.end + s, 2)} for w in words or []]
                out.append({"start": round(s, 2), "end": round(e, 2), "text": text.strip(), "words": ws})
                if e >= next_note:
                    log(f"{e / 60:.0f} of {duration / 60:.0f} min done")
                    next_note += 300.0
    done = time.monotonic()
    return {"engine": "gigaam", "language": "ru", "language_probability": None, "duration": round(duration, 2),
            "model": a.gigaam_model, "compute_type": "float32", "threads": a.threads, "vad": a.vad, "vad_options": a.vad_options, "chunks": len(chunks), "forced_cuts": forced,
            "load_seconds": round(loaded - started, 2), "transcribe_seconds": round(done - loaded, 2), "segments": out}


def main():
    p = argparse.ArgumentParser(description="Transcribe one audio file on the CPU with faster-whisper or GigaAM.")
    p.add_argument("audio")
    p.add_argument("--out", required=True, help="where to write the JSON result")
    p.add_argument("--engine", choices=["whisper", "gigaam"], default="whisper")
    p.add_argument("--engines", default=None, help="Whisper without --language: JSON engine per language; detect, route, transcribe")
    p.add_argument("--language-floor", type=float, default=LANGUAGE_FLOOR, help="with --engines: how sure the detection must be")
    p.add_argument("--language-fallback", default="auto", help="with --engines: auto, or a language code for an unsure detection")
    p.add_argument("--words", action="store_true", help="Whisper: word timestamps and probabilities")
    p.add_argument("--hotwords", default="", help="Whisper: terms to favour (faster-whisper hotwords)")
    p.add_argument("--model", default="large-v3-turbo", help="the Whisper model")
    p.add_argument("--gigaam-model", default="v3_e2e_rnnt")
    p.add_argument("--compute-type", default="int8")
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--language", default=None, help="a language code such as ru or en; detected when not given")
    p.add_argument("--models-dir", default=None, help="where models are downloaded and cached")
    p.add_argument("--vad", choices=sorted(VADS), default="silero", help="GigaAM: how speech is found in long audio")
    p.add_argument("--vad-options", default="{}", help="GigaAM: JSON with threshold, min_silence_duration_ms, speech_pad_ms")
    a = p.parse_args()
    try:
        given = json.loads(a.vad_options or "{}")
        a.vad_options = {k: given.get(k, v) for k, v in VAD_DEFAULTS.items()}
    except (ValueError, AttributeError):
        log(f"error: --vad-options is not a JSON object: {a.vad_options}")
        return 2
    try:
        engines = json.loads(a.engines) if a.engines else None
        if engines is not None and not isinstance(engines, dict):
            raise ValueError
    except ValueError:
        log(f"error: --engines is not a JSON object: {a.engines}")
        return 2
    a.engines = engines
    if not os.path.isfile(a.audio):
        log(f"error: no such file: {a.audio}")
        return 1

    started = time.monotonic()
    try:
        import faster_whisper  # noqa: F401  (the audio decoder and the VAD for both engines)
    except ImportError as e:
        log(f"error: faster-whisper is not installed in this Python ({e}); run deploy/modules/transcribe.sh")
        return 1
    if a.engine == "whisper" and a.engines and not a.language:
        result = run_auto(a, started)
    elif a.engine == "gigaam":
        result = run_gigaam(a, started)
    else:
        result = run_whisper(a, started)
    result["peak_rss_mb"] = peak_rss_mb()
    write_json(a.out, result)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:  # one line for the .failed note; the traceback is not useful to the user
        log(f"error: {type(e).__name__}: {e}")
        sys.exit(1)
