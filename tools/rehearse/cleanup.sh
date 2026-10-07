#!/usr/bin/env bash
# Remove what tools/rehearse/rehearse.sh installed, so the rehearsal can run on a machine that is kept:
#   - the CometScout systemd user units that run code from the test home (stopped and disabled first), the timer's
#     last-run stamp, the rehearsal's drop-in and its stand-ins for the units from before the rename;
#   - the test home itself (it holds the install, the drop folder, the second home and the work files).
# Units of any other install (they name another folder) are left alone, and so are apt packages and lingering, which
# install.sh sets up on any server.
#   bash tools/rehearse/cleanup.sh [--dir <test home>]      (default ~/cometscout-rehearsal)
# It refuses a folder that rehearse.sh did not make (no .cometscout-rehearsal file in it).
set -uo pipefail
TH="$HOME/cometscout-rehearsal"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) TH="${2:?--dir needs a folder}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -uo/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)"; exit 2 ;;
  esac
done
case "$TH" in /*) ;; *) TH="$(pwd)/$TH" ;; esac
TH="${TH%/}"
UNITDIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
if [ -e "$TH" ] && [ ! -f "$TH/.cometscout-rehearsal" ]; then echo "$TH was not made by tools/rehearse/rehearse.sh (no .cometscout-rehearsal in it); not touching it."; exit 1; fi

# the units that name the test home: the ones cli.mjs timer wrote for it, the drop-in and the stand-ins
mine=()
if [ -d "$UNITDIR" ]; then
  while IFS= read -r -d '' f; do grep -qF "$TH/" "$f" 2>/dev/null || grep -qF "($TH)" "$f" 2>/dev/null && mine+=("$(basename "$f")"); done \
    < <(find "$UNITDIR" -maxdepth 1 -type f -print0)
  # a timer or path unit names no folder; it belongs to the install whose service of the same name is in the list
  for u in "${mine[@]}"; do case "$u" in *.service) for t in "${u%.service}.timer" "${u%.service}.path"; do [ -f "$UNITDIR/$t" ] && [[ " ${mine[*]} " != *" $t "* ]] && mine+=("$t"); done ;; esac; done
fi
sc() { systemctl --user "$@" 2>/dev/null; }
for u in "${mine[@]}"; do case "$u" in *.timer|*.path) sc disable --now "$u" ;; esac; done
for u in "${mine[@]}"; do case "$u" in *@.service) ;; *.service) sc disable "$u"; sc stop "$u" ;; esac; done
STAMPS="${XDG_DATA_HOME:-$HOME/.local/share}/systemd/timers"
for u in "${mine[@]}"; do
  rm -f "$UNITDIR/$u"; for w in "$UNITDIR"/*.wants; do [ -d "$w" ] && rm -f "$w/$u"; done
  # a persistent timer's last-run stamp: a stale one would start a catch-up run as soon as the next rehearsal enables it
  case "$u" in *.timer) rm -f "$STAMPS/stamp-$u" ;; esac
done
for d in "$UNITDIR"/*.service.d; do
  [ -d "$d" ] || continue
  for f in "$d"/*.conf; do [ -f "$f" ] && grep -qF "($TH)" "$f" && rm -f "$f" && mine+=("$(basename "$d")/$(basename "$f")"); done
  rmdir "$d" 2>/dev/null || true
done
sc daemon-reload
sc reset-failed 'cometscout*'
[ ${#mine[@]} -gt 0 ] && echo "Removed units: ${mine[*]}" || echo "No units of $TH were installed."
if [ -e "$TH" ]; then
  chmod -R u+w "$TH" 2>/dev/null
  rm -rf "$TH" && echo "Removed $TH." || { echo "Could not remove $TH."; exit 1; }
else echo "$TH is not there."; fi
echo "Left in place: apt packages and lingering (install.sh sets them up on any server; sudo loginctl disable-linger $USER turns lingering off)."
