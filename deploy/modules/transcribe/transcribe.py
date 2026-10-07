#!/usr/bin/env python3
"""CometScout transcription module: one audio file in, JSON segments out.

Runs inside the module's own virtual environment, where deploy/modules/transcribe.sh installed faster-whisper.
CometScout (lib/transcribe.mjs) starts it under nice and ionice; this script only transcribes.

  python transcribe.py --out result.json [--model medium] [--compute-type int8] [--threads 2] [--language ru]
                       [--models-dir DIR] AUDIO

result.json: {"language", "language_probability", "duration", "model", "compute_type", "threads",
              "load_seconds", "transcribe_seconds", "peak_rss_mb", "segments": [{"start", "end", "text"}]}
Progress goes to stderr. Exit 0 on success, 2 on a usage error, 1 on any other failure (the reason on stderr).
The model is downloaded into --models-dir on first use (small about 0.5 GB, medium 1.5 GB, large-v3 3 GB).
"""
import argparse
import json
import os
import sys
import time


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


def main():
    p = argparse.ArgumentParser(description="Transcribe one audio file with faster-whisper on the CPU.")
    p.add_argument("audio")
    p.add_argument("--out", required=True, help="where to write the JSON result")
    p.add_argument("--model", default="medium")
    p.add_argument("--compute-type", default="int8")
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--language", default=None, help="a language code such as ru or en; detected when not given")
    p.add_argument("--models-dir", default=None, help="where models are downloaded and cached")
    a = p.parse_args()
    if not os.path.isfile(a.audio):
        log(f"error: no such file: {a.audio}")
        return 1

    started = time.monotonic()
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        log(f"error: faster-whisper is not installed in this Python ({e}); run deploy/modules/transcribe.sh")
        return 1
    allow_newer_pyav()
    log(f"loading model {a.model} ({a.compute_type}, {a.threads} threads); the first use downloads it")
    model = WhisperModel(a.model, device="cpu", compute_type=a.compute_type, cpu_threads=max(1, a.threads),
                         download_root=a.models_dir)
    loaded = time.monotonic()
    segments, info = model.transcribe(a.audio, language=a.language or None, vad_filter=True)
    log(f"language {info.language} ({info.language_probability:.0%}), {info.duration:.0f} s of audio")
    out, next_note = [], 300.0
    for s in segments:  # the generator does the work as it is read
        out.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()})
        if s.end >= next_note:
            log(f"{s.end / 60:.0f} of {info.duration / 60:.0f} min done")
            next_note += 300.0
    done = time.monotonic()
    result = {
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 2),
        "model": a.model,
        "compute_type": a.compute_type,
        "threads": a.threads,
        "load_seconds": round(loaded - started, 2),
        "transcribe_seconds": round(done - loaded, 2),
        "peak_rss_mb": peak_rss_mb(),
        "segments": out,
    }
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(tmp, a.out)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:  # one line for the .failed note; the traceback is not useful to the user
        log(f"error: {type(e).__name__}: {e}")
        sys.exit(1)
