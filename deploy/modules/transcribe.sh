#!/usr/bin/env bash
# Optional module: speech to text on this server's CPU with faster-whisper (https://github.com/SYSTRAN/faster-whisper, MIT).
# Creates a Python virtual environment next to the CometScout home (default <home>/../cometscout-transcribe, or
# modules.transcribe.path in settings.json) and installs the pinned faster-whisper there; run it again to repair or
# move to a newer pin. No model is downloaded here: the first job downloads the configured one into the module folder.
#   bash deploy/modules/transcribe.sh
#   PYTHON=/usr/bin/python3.12 bash deploy/modules/transcribe.sh     # another Python
# The work is done by lib/transcribe.mjs (the same code runs on Windows through transcribe.ps1). It installs with the
# pinned libraries in deploy/modules/transcribe/constraints.txt (pip -c) and needs Python 3.11 to 3.14.
set -euo pipefail
CODE="$(cd "$(dirname "$0")/../.." && pwd)"
PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null; then
  echo "python3 is needed: sudo apt-get install -y python3 python3-venv"; exit 1
fi
exec node "$CODE/lib/transcribe.mjs" install "$@"
