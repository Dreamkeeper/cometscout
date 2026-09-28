#!/usr/bin/env bash
# jobpilot installer for a standard Debian or Ubuntu VPS. Run it as the user who will own the pipeline
# (not root); it uses sudo only for packages and for keeping user timers alive after logout.
#   bash deploy/install.sh            # install packages, create settings/.env, install the daily timer
#   JOBPILOT_TIME=19:30 bash deploy/install.sh
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

echo "==> Daily timer (systemd user unit)"
TIME="${JOBPILOT_TIME:-18:00}"
TZ_NAME="$(node -p "try{require('./settings.json').timezone||''}catch(e){''}")"
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/jobpilot.service <<EOF
[Unit]
Description=jobpilot evening run: sources, decode, picks, application packs
[Service]
Type=oneshot
WorkingDirectory=${HOME_DIR}
# systemd user units get a minimal PATH; keep the one that finds claude/codex (~/.local/bin, npm globals)
Environment="PATH=${HOME}/.local/bin:${PATH}"
ExecStart=$(command -v node) ${HOME_DIR}/cli.mjs run
TimeoutStartSec=2h
EOF
cat > ~/.config/systemd/user/jobpilot.timer <<EOF
[Unit]
Description=Run jobpilot every evening
[Timer]
OnCalendar=*-*-* ${TIME}:00${TZ_NAME:+ ${TZ_NAME}}
Persistent=true
[Install]
WantedBy=timers.target
EOF
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now jobpilot.timer
systemctl --user list-timers jobpilot.timer --no-pager || true   # no | head: with pipefail, SIGPIPE would end the script

echo "==> Check"
node cli.mjs doctor
echo "Next: open this folder in Claude Code or Codex and say \"set me up\" (see AGENTS.md)."
