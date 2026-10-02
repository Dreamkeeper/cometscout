#!/usr/bin/env bash
# jobpilot installer for a standard Debian or Ubuntu VPS. Run it as the user who will own the pipeline
# (not root); it uses sudo only for packages and for keeping user timers alive after logout.
#   bash deploy/install.sh            # install packages, create settings/.env, install the daily timer
#   JOBPILOT_TIME=19:30 bash deploy/install.sh   (or set run_time in settings.json, then: node cli.mjs timer)
set -euo pipefail
cd "$(dirname "$0")/.."
HOME_DIR="$(pwd)"

echo "==> Packages (Python, LibreOffice for PDF export, fonts)"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3 libreoffice-writer-nogui fonts-liberation fonts-roboto curl ca-certificates >/dev/null

echo "==> Node.js 20+"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Node 20 or newer is needed. On Debian 13 run: sudo apt-get install -y nodejs"
  echo "Elsewhere: https://github.com/nodesource/distributions (then rerun this script)"; exit 1
fi

echo "==> Browser libraries for the workspace (preact, htm; exact versions from package-lock.json)"
if command -v npm >/dev/null; then
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
else
  echo "npm not found; the workspace (node cli.mjs serve) needs it once: sudo apt-get install -y npm && npm ci --omit=dev"
fi

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
# run_time and timezone in settings.json, "node cli.mjs timer" re-installs it with those values.
# The run unit gets OnFailure=jobpilot-failure@%n.service: a failed run sends a Telegram alert through
# "node cli.mjs notify" (template: deploy/jobpilot-failure@.service, installed with the paths filled in).
sudo loginctl enable-linger "$USER"
node cli.mjs timer "${JOBPILOT_TIME:-}" || true

echo "==> Check"
node cli.mjs doctor
echo "Next: open this folder in Claude Code or Codex and say \"set me up\" (see AGENTS.md)."
