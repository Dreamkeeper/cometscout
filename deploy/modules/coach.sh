#!/usr/bin/env bash
# Optional module: the interview coach by Noam Segal (https://github.com/noamseg/interview-coach-skill, MIT).
# Installs it from its own upstream into a folder next to the CometScout home (default <home>/../interview-coach, or
# modules.coach.path in settings.json), or updates it there. Its files are never copied into this repository, and
# nothing the coach writes in its folder (coaching_state.md, materials/) is ever deleted.
#   bash deploy/modules/coach.sh            # install the first time, update after
#   GIT=/path/to/git bash deploy/modules/coach.sh
# The work is done by lib/coach.mjs (the same code runs on Windows through coach.ps1).
set -euo pipefail
CODE="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -z "${GIT:-}" ] && ! command -v git >/dev/null; then
  echo "git is needed: sudo apt-get install -y git"; exit 1
fi
exec node "$CODE/lib/coach.mjs" install "$@"
