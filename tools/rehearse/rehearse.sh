#!/usr/bin/env bash
# CometScout install rehearsal: the path a new user takes, end to end, on a fresh Debian 12/13 or Ubuntu 22.04/24.04
# machine with systemd. Run it as a normal user with passwordless sudo and a user systemd session (lingering, or a
# login). It needs no model, Telegram, Gmail or job board: the run reads three synthetic jobs from the drop-dir
# source, and the model is a canned answer (COMETSCOUT_LLM_FAKE, set only in a drop-in of this run's own service and
# never in .env). install.sh itself does reach the network: apt packages and npm ci.
#
#   bash tools/rehearse/rehearse.sh [--ref <tag|branch|sha>] [--keep] [--dir <test home>] [--log <file>]
#     --ref    what to install (default: the commit this checkout is on; uncommitted changes are not part of it)
#     --keep   leave the install, its units and the test home in place for a look; tools/rehearse/cleanup.sh removes them
#     --dir    the test home (default ~/cometscout-rehearsal): the checkout that becomes the CometScout home, the drop
#              folder, a second home for the import and the work files all live in it
#     --log    the full log (default /tmp/cometscout-rehearsal-<time>.log)
#
# Steps, each PASS or FAIL with its time, then a summary; the exit code is 1 when any step failed:
#   1 install   bash deploy/install.sh in a clone of the ref
#   2 layout    app/releases/v<version> and app/current; doctor has no TODO beyond the expected ones (EXPECTED_TODOS in
#               tools/rehearse/lib.mjs: the model CLI, which the rehearsal never installs, and the example profile)
#   3 profile   profile.example copied to profile/, settings for drop-dir and a fixed schedule, node cli.mjs timer, doctor
#   4 units     cometscout.timer enabled at that time, the failure alert runs, the run unit on app/current, lingering
#   5 run       systemctl --user start cometscout.service: jobs decoded, picks, digest, packs, a backup, no Telegram
#   6 workspace serve --check, then serve on a free port answering / and /api/today
#   7 backup    backup, a changed file, restore --dry-run lists it, restore brings it back
#   8 export    export, import into a second fresh home, the same file hashes both ways
#   9 update    --adopt and install.sh again change nothing, --to the same version is refused, an update to a fake next version from a local
#               source zip (--from-zip, with its sha256), rollback, the units still on app/current
#  10 old names the units from before the rename (lib/legacy-names.mjs) are replaced by node cli.mjs timer
#  11 cleanup   tools/rehearse/cleanup.sh (not with --keep)
#
# It never touches anything outside the test home and the systemd user units it created, apart from what
# install.sh does on any server (apt packages, loginctl enable-linger), which it leaves in place. It refuses to start
# when CometScout units (or ones from before the rename) are already installed for this user.
set -uo pipefail
ME="${USER:-$(id -un)}"   # USER is unset in some minimal shells (docker exec), and set -u would stop the script

SRC="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$SRC/tools/rehearse/lib.mjs"
REF=""; KEEP=""; TH="$HOME/cometscout-rehearsal"; LOG="/tmp/cometscout-rehearsal-$(date +%Y%m%d-%H%M%S).log"
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a tag, branch or commit}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --dir) TH="${2:?--dir needs a folder}"; shift 2 ;;
    --log) LOG="${2:?--log needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -uo/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)"; exit 2 ;;
  esac
done
case "$TH" in /*) ;; *) TH="$(pwd)/$TH" ;; esac
H="$TH/home"; DROP="$TH/drop"; WORK="$TH/work"; HOME2="$TH/second-home"
UNITDIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DROPIN_DIR="$UNITDIR/cometscout.service.d"; DROPIN="$DROPIN_DIR/zz-rehearsal.conf"
MARK="$TH/.cometscout-rehearsal"
RESULTS="$(mktemp)"; DETAIL="$(mktemp)"; STEP_OUT="$(mktemp)"
trap 'rm -f "$RESULTS" "$DETAIL" "$STEP_OUT"' EXIT
mkdir -p "$(dirname "$LOG")"; : > "$LOG"

# Only this script's own settings reach CometScout: variables from the caller's shell (a home, a settings file, a
# canned model) would point the rehearsal somewhere else. The names from before the rename come from lib/legacy-names.mjs.
OLD_PREFIX="$(node "$HELPER" old-env-prefix 2>/dev/null || true)"
for v in $(compgen -e); do case "$v" in COMETSCOUT_*) unset "$v" ;; esac; [ -n "$OLD_PREFIX" ] && [ "${v#"$OLD_PREFIX"}" != "$v" ] && unset "$v"; done

say() { echo "$*" | tee -a "$LOG"; }
helper() { node "$HELPER" "$@"; }
fail() { echo "$*" > "$DETAIL"; echo "FAIL: $*"; exit 1; }
cs() { (cd "$H" && node cli.mjs "$@"); }
ABORT=""
# step <number> <name> <function>: runs the function in a subshell with set -e, its output in the log
step() {
  local name="$1 $2" fn="$3" t0 t1 rc secs detail
  if [ -n "$ABORT" ]; then printf '%s\tSKIP\t0\t%s\n' "$name" "$ABORT" >> "$RESULTS"; say "SKIP $name ($ABORT)"; return 0; fi
  echo "==> $name" | tee -a "$LOG"; : > "$DETAIL"
  t0=$(date +%s.%N)
  ( set -e; "$fn" ) > "$STEP_OUT" 2>&1; rc=$?
  t1=$(date +%s.%N); secs=$(awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.1f", b - a }')
  cat "$STEP_OUT" >> "$LOG"
  if [ "$rc" = 0 ]; then printf '%s\tPASS\t%s\t\n' "$name" "$secs" >> "$RESULTS"; say "PASS $name (${secs}s)"; return 0; fi
  detail="$(head -c 300 "$DETAIL" | tr '\t\n' '  ')"
  [ -n "$detail" ] || detail="a command failed (exit $rc): $(grep -v '^\s*$' "$STEP_OUT" | tail -1 | head -c 200 | tr '\t' ' ')"
  printf '%s\tFAIL\t%s\t%s\n' "$name" "$secs" "$detail" >> "$RESULTS"
  say "FAIL $name (${secs}s): $detail"; echo "---- last lines of this step (full log: $LOG)"; tail -n 25 "$STEP_OUT"; echo "----"
  return 1
}

# ---------- 0. preflight: nothing is written before it passes ----------
preflight() {
  [ "$(id -u)" != 0 ] || fail "run it as a normal user with sudo, not as root"
  command -v git >/dev/null || fail "git is not installed"
  command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || fail "Node 20 or newer is needed (the installer checks it too)"
  command -v curl >/dev/null || fail "curl is not installed"
  sudo -n true 2>/dev/null || fail "sudo must work without a password for this user"
  systemctl --user show-environment >/dev/null 2>&1 || fail "no user systemd session (sudo loginctl enable-linger $ME, then log in again, or set XDG_RUNTIME_DIR)"
  [ ! -e "$TH" ] || fail "$TH exists: a previous rehearsal? bash tools/rehearse/cleanup.sh --dir $TH removes it"
  local old; old="$(helper old-units)" || fail "cannot read the old unit names"
  for u in cometscout.timer cometscout.service cometscout-bot.service cometscout-failure@.service $old; do
    [ ! -e "$UNITDIR/$u" ] || fail "$UNITDIR/$u exists: another install's units would be replaced; rehearse as another user or on another machine"
  done
  # a persistent timer's stamp left by an earlier install would start a catch-up run as soon as the timer is enabled
  local stamps="${XDG_DATA_HOME:-$HOME/.local/share}/systemd/timers"
  for u in cometscout.timer $old; do
    [ ! -e "$stamps/stamp-$u" ] || fail "$stamps/stamp-$u is left from an earlier install (its timer would start a run at once); remove it first"
  done
  git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1 || fail "$SRC is not a git checkout"
  [ -n "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] && echo "note: uncommitted changes in $SRC are not part of the rehearsal (it installs a commit)"
  echo "ok: $(node --version), $(git --version), systemd user session, sudo"
}

# ---------- 1. install ----------
install_step() {
  mkdir -p "$TH" "$WORK"; echo "made by tools/rehearse/rehearse.sh; bash tools/rehearse/cleanup.sh --dir $TH removes it" > "$MARK"
  git clone --quiet "$SRC" "$H"
  local ref="${REF:-$(git -C "$SRC" rev-parse HEAD)}" commit=""
  if git -C "$H" rev-parse -q --verify "$ref^{commit}" >/dev/null; then commit="$ref"
  elif git -C "$H" rev-parse -q --verify "origin/$ref^{commit}" >/dev/null; then commit="origin/$ref"
  else
    local url; url="$(git -C "$SRC" remote get-url origin 2>/dev/null)" || fail "$ref is not in $SRC and it has no origin to fetch it from"
    git -C "$H" fetch --quiet "$url" "$ref" || fail "cannot fetch $ref from $url"; commit=FETCH_HEAD
  fi
  git -C "$H" checkout --quiet --detach "$commit"
  echo "installing $(git -C "$H" log -1 --format='%h %s') from $ref"
  (cd "$H" && bash deploy/install.sh) || fail "deploy/install.sh exited $?"
}

# ---------- 2. layout ----------
layout_step() {
  [ -f "$H/app/releases/v$VER/cli.mjs" ] || fail "no app/releases/v$VER/cli.mjs"
  [ -L "$H/app/current" ] || fail "app/current is not a link"
  [ "$(readlink -f "$H/app/current")" = "$(readlink -f "$H/app/releases/v$VER")" ] || fail "app/current points at $(readlink "$H/app/current"), not releases/v$VER"
  [ -f "$H/app/releases/v$VER/node_modules/preact/package.json" ] || fail "the workspace modules are not installed in the release"
  [ -f "$H/settings.json" ] || fail "install.sh made no settings.json"
  [ "$(stat -c %a "$H/.env")" = 600 ] || fail ".env is not mode 600"
  cs doctor > "$WORK/doctor-install.txt" 2>&1 || fail "doctor exited non-zero"
  cat "$WORK/doctor-install.txt"
  helper doctor-check "$WORK/doctor-install.txt" install > "$WORK/todo.txt" || fail "unexpected doctor TODO: $(tr '\n' ' ' < "$WORK/todo.txt")"
}

# ---------- 3. profile ----------
profile_step() {
  cp -r "$H/profile.example" "$H/profile"
  mkdir -p "$DROP"
  helper settings "$H/settings.json" "$DROP" "$TIME"
  cs timer || fail "node cli.mjs timer exited non-zero"
  cs doctor > "$WORK/doctor-profile.txt" 2>&1 || fail "doctor exited non-zero"
  cat "$WORK/doctor-profile.txt"
  grep -q '^ok   profile: profile$' "$WORK/doctor-profile.txt" || fail "doctor does not see profile/"
  grep -q "^ok   drop-dir folder: $DROP" "$WORK/doctor-profile.txt" || fail "doctor does not see the drop-dir folder"
  helper doctor-check "$WORK/doctor-profile.txt" profile > "$WORK/todo.txt" || fail "unexpected doctor TODO: $(tr '\n' ' ' < "$WORK/todo.txt")"
}

# ---------- 4. units ----------
units_step() {
  systemctl --user list-timers cometscout.timer --no-pager || true
  [ "$(systemctl --user is-enabled cometscout.timer)" = enabled ] || fail "cometscout.timer is not enabled"
  systemctl --user is-active --quiet cometscout.timer || fail "cometscout.timer is not active"
  grep -qx "OnCalendar=\*-\*-\* $TIME:00 UTC" "$UNITDIR/cometscout.timer" || fail "cometscout.timer does not run at $TIME UTC: $(grep OnCalendar "$UNITDIR/cometscout.timer")"
  [ -f "$UNITDIR/cometscout-failure@.service" ] || fail "cometscout-failure@.service is missing"
  systemctl --user cat cometscout-failure@cometscout.service.service >/dev/null || fail "systemd cannot read the failure template"
  grep -q "^ExecStart=.* $H/app/current/cli.mjs notify" "$UNITDIR/cometscout-failure@.service" || fail "the failure template does not run app/current"
  grep -qx 'OnFailure=cometscout-failure@%n.service' "$UNITDIR/cometscout.service" || fail "cometscout.service has no OnFailure="
  grep -q "^ExecStart=.* $H/app/current/cli.mjs run$" "$UNITDIR/cometscout.service" || fail "cometscout.service does not run app/current/cli.mjs"
  grep -qx "Environment=\"COMETSCOUT_HOME=$H\"" "$UNITDIR/cometscout.service" || fail "cometscout.service does not set COMETSCOUT_HOME"
  [ "$(loginctl show-user "$ME" -p Linger --value)" = yes ] || fail "lingering is not enabled for $ME"
  # the failure alert runs (Telegram is off, so it logs the message and succeeds)
  systemctl --user start cometscout-failure@rehearsal-check.service || fail "the failure alert unit failed"
  echo "units ok"
}

# ---------- 5. one evening run, through the service ----------
run_step() {
  helper jobs "$DROP"
  helper fake-model "$H/profile/cv-library.json" "$WORK/fake-model.json"
  mkdir -p "$DROPIN_DIR"
  # for this run only: the canned model answer and no link checks (no network); removed right after
  printf '# tools/rehearse/rehearse.sh, removed after its run (%s)\n[Service]\nEnvironment="COMETSCOUT_LLM_FAKE=%s"\nEnvironment="COMETSCOUT_NO_LINK_CHECK=1"\n' "$TH" "$WORK/fake-model.json" > "$DROPIN"
  systemctl --user daemon-reload
  local since; since="$(date '+%Y-%m-%d %H:%M:%S')"
  local rc=0; timeout 1500 systemctl --user start cometscout.service || rc=$?
  rm -f "$DROPIN"; rmdir "$DROPIN_DIR" 2>/dev/null || true; systemctl --user daemon-reload
  journalctl --user -u cometscout.service --since "$since" --no-pager -o cat > "$WORK/run.txt" 2>&1 || true
  cat "$WORK/run.txt"
  [ "$rc" = 0 ] || fail "systemctl --user start cometscout.service exited $rc (result: $(systemctl --user show cometscout.service -p Result --value))"
  [ "$(systemctl --user show cometscout.service -p Result --value)" = success ] || fail "the run's result is $(systemctl --user show cometscout.service -p Result --value)"
  ! grep -q LLM_FAKE "$H/.env" || fail "COMETSCOUT_LLM_FAKE ended up in .env"
  [ "$(ls "$DROP/processed" 2>/dev/null | wc -l)" = 3 ] || fail "drop-dir did not process the 3 job files: $(ls "$DROP" "$DROP/processed" 2>&1 | tr '\n' ' ')"
  local decoded; decoded="$(grep -l '^verdict: strong-fit' "$H"/data/decoded/*.md 2>/dev/null | wc -l)"
  [ "$decoded" = 3 ] || fail "$decoded of 3 jobs decoded as strong-fit (canned): $(ls "$H/data/inbox" "$H/data/decoded" "$H/data/rejected" 2>&1 | tr '\n' ' ')"
  [ -s "$H/data/state/picks.json" ] || fail "no data/state/picks.json"
  ls "$H"/data/digests/*.md >/dev/null 2>&1 || fail "no digest in data/digests"
  local docx pdf; docx="$(find "$H/data/packs" -name '*.docx' | wc -l)"; pdf="$(find "$H/data/packs" -name '*.pdf' | wc -l)"
  [ "$docx" -ge 1 ] || fail "no pack was built (no .docx in data/packs)"
  [ "$pdf" -ge 1 ] || fail "the pack has no PDF (LibreOffice)"
  ls "$H"/backups/cometscout-backup-*.zip >/dev/null 2>&1 || fail "the run made no nightly backup"
  ! grep -qiE 'api\.telegram\.org|telegram failed|sent to telegram' "$WORK/run.txt" || fail "the run tried Telegram"
  echo "decoded $decoded, packs: $docx docx, $pdf pdf; digest $(ls "$H"/data/digests/)"
}

# ---------- 6. workspace ----------
serve_step() {
  cs serve --check || fail "serve --check failed"
  local port pid=""; port="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
  # its own session, so stopping it also stops the release it hands the command to
  (cd "$H" && exec setsid node cli.mjs serve --port "$port") > "$WORK/serve.txt" 2>&1 & pid=$!
  local ok=""; for _ in $(seq 60); do curl -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null && { ok=1; break; }; sleep 0.5; done
  local page today rc=0
  page="$(curl -fsS "http://127.0.0.1:$port/" 2>&1)" || rc=1
  today="$(curl -fsS "http://127.0.0.1:$port/api/today" 2>&1)" || rc=1
  kill -TERM -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  pkill -f "cli.mjs serve --port $port" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  for _ in $(seq 20); do curl -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null || break; sleep 0.5; done
  cat "$WORK/serve.txt"
  [ -n "$ok" ] && [ "$rc" = 0 ] || fail "the workspace did not answer on port $port"
  echo "$page" | grep -qi '<html' || fail "/ is not the workspace page"
  echo "$today" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{JSON.parse(s)})' || fail "/api/today is not JSON"
  ! curl -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null || fail "the workspace still answers after it was stopped"
  echo "workspace answered on $port"
}

# ---------- 7. backup and restore ----------
backup_step() {
  cs backup --label rehearsal || fail "backup failed"
  local b; b="$(cd "$H/backups" && ls -t cometscout-backup-*--rehearsal.zip | head -1)"; [ -n "$b" ] || fail "no backup labelled rehearsal"
  local f="$H/profile/voice.md" before after
  before="$(sha256sum "$f" | cut -d' ' -f1)"
  printf '\nA change the restore must undo (rehearsal).\n' >> "$f"
  cs restore "$b" --dry-run > "$WORK/restore-dry.txt" || fail "restore --dry-run failed"
  cat "$WORK/restore-dry.txt"
  grep -q 'profile/voice.md: replace with the archived copy' "$WORK/restore-dry.txt" || fail "restore --dry-run does not list profile/voice.md"
  [ "$(sha256sum "$f" | cut -d' ' -f1)" != "$before" ] || fail "the dry run changed the file"
  cs restore "$b" || fail "restore failed"
  after="$(sha256sum "$f" | cut -d' ' -f1)"
  [ "$after" = "$before" ] || fail "profile/voice.md is not back as it was"
  ls "$H"/backups/*--pre-restore.zip >/dev/null 2>&1 || fail "the restore made no pre-restore backup"
}

# ---------- 8. export and import into a second fresh home ----------
export_step() {
  cs export --out "$WORK/export.zip" || fail "export failed"
  mkdir -p "$HOME2"
  (cd "$HOME2" && COMETSCOUT_HOME="$HOME2" node "$H/app/current/cli.mjs" import --from "$WORK/export.zip") || fail "import into the second home failed"
  helper export-check "$WORK/export.zip" "$H" "$HOME2" > "$WORK/diff.txt" || fail "after the import: $(head -5 "$WORK/diff.txt" | tr '\n' ' ')"
  (cd "$HOME2" && COMETSCOUT_HOME="$HOME2" node "$H/app/current/cli.mjs" export --out "$WORK/export2.zip") || fail "export of the second home failed"
  helper export-check "$WORK/export2.zip" "$H" > "$WORK/diff.txt" || fail "the second home holds files the first does not: $(head -5 "$WORK/diff.txt" | tr '\n' ' ')"
  echo "round trip ok"
}

# ---------- 9. update and rollback ----------
update_step() {
  local before; before="$(ls "$H/app/releases")"
  cs update --adopt > "$WORK/adopt.txt" 2>&1 || { cat "$WORK/adopt.txt"; fail "update --adopt on an installed layout exited non-zero"; }
  cat "$WORK/adopt.txt"
  grep -q 'nothing to adopt' "$WORK/adopt.txt" || fail "update --adopt did something on an installed layout"
  [ "$(ls "$H/app/releases")" = "$before" ] || fail "update --adopt changed app/releases"
  # install.sh again (what a user does after a git pull, or to repair): nothing changes
  local units; units="$(cat "$UNITDIR/cometscout.service" "$UNITDIR/cometscout.timer" "$UNITDIR/cometscout-failure@.service" | sha256sum)"
  (cd "$H" && bash deploy/install.sh) > "$WORK/install-again.txt" 2>&1 || { cat "$WORK/install-again.txt"; fail "deploy/install.sh run again exited non-zero"; }
  cat "$WORK/install-again.txt"
  grep -q 'nothing to adopt' "$WORK/install-again.txt" || fail "deploy/install.sh run again did not find the installed layout"
  [ "$(ls "$H/app/releases")" = "$before" ] || fail "deploy/install.sh run again changed app/releases"
  [ "$(cat "$UNITDIR/cometscout.service" "$UNITDIR/cometscout.timer" "$UNITDIR/cometscout-failure@.service" | sha256sum)" = "$units" ] || fail "deploy/install.sh run again changed the units"
  local rc=0; cs update --to "v$VER" > "$WORK/same.txt" 2>&1 || rc=$?
  cat "$WORK/same.txt"
  [ "$rc" = 1 ] && grep -q "is not newer than v$VER" "$WORK/same.txt" || fail "update --to v$VER (the same version) was not refused cleanly (exit $rc)"
  rc=0; cs update --to "v$NEXT" --from-zip "$WORK/missing.zip" > "$WORK/nozip.txt" 2>&1 || rc=$?
  [ "$rc" = 1 ] || fail "update --from-zip without --sha256 was not refused"
  local sha; sha="$(helper build-zip "$H/app/current" "$NEXT" "$WORK/cometscout-$NEXT.zip")" || fail "could not build the source zip of v$NEXT"
  rc=0; cs update --to "v$NEXT" --from-zip "$WORK/cometscout-$NEXT.zip" --sha256 "$(echo "$sha" | tr 0-9a-f 1-9a-f0)" > "$WORK/badsha.txt" 2>&1 || rc=$?
  cat "$WORK/badsha.txt"
  [ "$rc" = 1 ] && grep -q 'does not match the sha256' "$WORK/badsha.txt" || fail "a wrong --sha256 was not refused"
  cs update --to "v$NEXT" --from-zip "$WORK/cometscout-$NEXT.zip" --sha256 "$sha" || fail "the update to v$NEXT failed"
  [ "$(readlink -f "$H/app/current")" = "$(readlink -f "$H/app/releases/v$NEXT")" ] || fail "app/current does not point at v$NEXT after the update"
  ls "$H"/backups/*--pre-update-v"$VER"-to-v"$NEXT".zip >/dev/null 2>&1 || fail "no pre-update backup"
  grep -q "^ExecStart=.* $H/app/current/cli.mjs run$" "$UNITDIR/cometscout.service" || fail "after the update the run unit does not run app/current"
  cs doctor > "$WORK/doctor-next.txt" 2>&1; grep -q "code: app/releases/v$NEXT" "$WORK/doctor-next.txt" || fail "doctor does not report v$NEXT"
  cs rollback || fail "rollback failed"
  [ "$(readlink -f "$H/app/current")" = "$(readlink -f "$H/app/releases/v$VER")" ] || fail "app/current does not point at v$VER after the rollback"
  grep -q "^ExecStart=.* $H/app/current/cli.mjs run$" "$UNITDIR/cometscout.service" || fail "after the rollback the run unit does not run app/current"
  [ "$(systemctl --user is-enabled cometscout.timer)" = enabled ] || fail "cometscout.timer is not enabled after the rollback"
}

# ---------- 10. units from before the rename ----------
oldnames_step() {
  local ot os; read -r ot os <<< "$(helper old-units)"
  [ -n "$ot" ] && [ -n "$os" ] || fail "cannot read the old unit names"
  printf '# tools/rehearse/rehearse.sh stand-in (%s)\n[Unit]\nDescription=Rehearsal stand-in for a unit from before the rename\n[Service]\nType=oneshot\nExecStart=/bin/true\n' "$TH" > "$UNITDIR/$os"
  printf '# tools/rehearse/rehearse.sh stand-in (%s)\n[Unit]\nDescription=Rehearsal stand-in for a timer from before the rename\n[Timer]\nOnCalendar=*-01-01 03:00:00\n[Install]\nWantedBy=timers.target\n' "$TH" > "$UNITDIR/$ot"
  systemctl --user daemon-reload
  systemctl --user enable --now "$ot"
  cs doctor > "$WORK/doctor-old.txt" 2>&1; grep -q 'old systemd units still installed' "$WORK/doctor-old.txt" || fail "doctor does not report the old units"
  cs timer || fail "node cli.mjs timer exited non-zero"
  [ ! -e "$UNITDIR/$ot" ] && [ ! -e "$UNITDIR/$os" ] || fail "the old unit files are still there"
  [ ! -e "$UNITDIR/timers.target.wants/$ot" ] || fail "the old timer is still wanted by timers.target"
  ! systemctl --user is-active --quiet "$ot" || fail "the old timer is still active"
  [ "$(systemctl --user is-enabled cometscout.timer)" = enabled ] || fail "cometscout.timer is not enabled"
  cs doctor > "$WORK/doctor-old.txt" 2>&1; ! grep -q 'old systemd units still installed' "$WORK/doctor-old.txt" || fail "doctor still reports old units"
}

# ---------- 11. cleanup ----------
cleanup_step() {
  bash "$SRC/tools/rehearse/cleanup.sh" --dir "$TH" || fail "cleanup.sh exited non-zero"
  [ ! -e "$TH" ] || fail "$TH is still there"
  ! ls "$UNITDIR"/cometscout* >/dev/null 2>&1 || fail "units are left: $(ls "$UNITDIR"/cometscout* | tr '\n' ' ')"
  ! systemctl --user is-active --quiet cometscout.timer || fail "cometscout.timer is still active"
}

say "CometScout install rehearsal: test home $TH, log $LOG"
TIME="$(date -u -d '+12 hours' +%H):17"   # a fixed time far from now, so the timer never fires during the rehearsal
VER=""; NEXT=""
if step 0 preflight preflight; then
  step 1 install install_step || ABORT="the install failed"
  if [ -z "$ABORT" ]; then VER="$(node -p "require('$H/package.json').version")"; NEXT="$(helper next-version "$VER")"; say "version v$VER; fake next version v$NEXT"; fi
  step 2 layout layout_step
  step 3 profile profile_step
  step 4 units units_step
  step 5 run run_step
  step 6 workspace serve_step
  step 7 backup-restore backup_step
  step 8 export-import export_step
  step 9 update-rollback update_step
  step 10 old-names oldnames_step
  ABORT=""
  if [ -n "$KEEP" ]; then
    printf '11 cleanup\tSKIP\t0\t--keep: left in place\n' >> "$RESULTS"
    say "Kept: $TH and its units. bash $SRC/tools/rehearse/cleanup.sh --dir $TH removes them."
  else step 11 cleanup cleanup_step; fi
fi
say ""; say "Rehearsal summary (${REF:-$(git -C "$SRC" log -1 --format=%h 2>/dev/null)} on $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"), Node $(node --version 2>/dev/null)):"
helper report "$RESULTS" | tee -a "$LOG"; code=${PIPESTATUS[0]}
say "Full log: $LOG"
exit "$code"
