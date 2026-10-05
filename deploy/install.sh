#!/usr/bin/env bash
# CometScout installer for a standard Debian or Ubuntu VPS. Run it as the user who will own the pipeline
# (not root); it uses sudo only for packages and for keeping user timers alive after logout.
#   bash deploy/install.sh            # install packages, create settings/.env, put the code in app/releases, install the daily timer
#   COMETSCOUT_TIME=19:30 bash deploy/install.sh   (or set schedule.time in settings.json, then: node cli.mjs timer)
# Before the rename CometScout was called jobpilot: JOBPILOT_TIME still works, and an install in ~/jobpilot is found
# and left in place, with how to move it here.
set -euo pipefail
cd "$(dirname "$0")/.."
HOME_DIR="$(pwd)"

OLD_HOME="$HOME/jobpilot"
KEEP_OLD=""
if [ -d "$OLD_HOME" ] && [ "$(cd "$OLD_HOME" && pwd -P)" != "$(pwd -P)" ] && { [ -f "$OLD_HOME/settings.json" ] || [ -d "$OLD_HOME/data" ]; }; then
  echo "==> Found an older install in $OLD_HOME (CometScout was called jobpilot). It is left as it is."
  echo "    To move it here: in $OLD_HOME run node cli.mjs export --out ~/move.zip and node cli.mjs export-secrets --out ~/move-secrets.enc,"
  echo "    then here: node cli.mjs import --from ~/move.zip and node cli.mjs import-secrets --from ~/move-secrets.enc."
  echo "    Its systemd units keep running next to the new ones until you move it; then run node cli.mjs timer here to remove them."
  KEEP_OLD="--keep-old-units"
fi

echo "==> Packages (Python, LibreOffice for PDF export, fonts)"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3 libreoffice-writer-nogui fonts-liberation fonts-roboto curl ca-certificates >/dev/null

echo "==> Node.js 20+"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Node 20 or newer is needed. On Debian 13 run: sudo apt-get install -y nodejs"
  echo "Elsewhere: https://github.com/nodesource/distributions (then rerun this script)"; exit 1
fi

echo "==> Code: app/releases/v<version>, with app/current pointing at it"
# This folder stays the CometScout home (settings, profile, .env, data, backups). The code runs from a copy in
# app/releases with its own browser libraries (preact, htm; npm ci --omit=dev), so node cli.mjs update can install the
# next version next to it and switch app/current back if anything fails. Running this script again changes nothing.
command -v npm >/dev/null || echo "npm not found; the workspace (node cli.mjs serve) needs it once: sudo apt-get install -y npm, then run this script again"
node cli.mjs update --adopt --no-units

echo "==> Claude Code or Codex CLI"
if ! command -v claude >/dev/null && ! command -v codex >/dev/null; then
  echo "Install one of them, then sign in once interactively:"
  echo "  Claude Code: npm install -g @anthropic-ai/claude-code && claude"
  echo "  Codex:       npm install -g @openai/codex && codex login"
fi

echo "==> Config files"
[ -f settings.json ] || cp settings.example.json settings.json
[ -f .env ] || { touch .env; chmod 600 .env; }
mkdir -p data

echo "==> Daily timer and failure alert (systemd user units)"
# The timer runs only once profile/ exists (cli.mjs run skips the example profile). After the onboarding sets
# schedule and timezone in settings.json, "node cli.mjs timer" re-installs it with those values (and the Telegram bot service when delivery is on).
# The run unit gets OnFailure=cometscout-failure@%n.service: a failed run sends a Telegram alert through
# "node cli.mjs notify" (template: deploy/cometscout-failure@.service, installed with the paths filled in).
sudo loginctl enable-linger "$USER"
node app/current/cli.mjs timer ${KEEP_OLD} "${COMETSCOUT_TIME:-${JOBPILOT_TIME:-}}" || true

echo "==> Check"
node app/current/cli.mjs doctor
echo "Next: open this folder in Claude Code or Codex and say \"set me up\" (see AGENTS.md)."
