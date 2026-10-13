#!/usr/bin/env bash
# Start the hubert server (if not running) and open/focus the native dashboard window.
#   HUBERT_PORT     port (default 7777)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
# Launchers (rofi, .desktop) start with a minimal PATH.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
# Health check for first-run setup: prints the same report as GET /api/doctor.
if [ "${1:-}" = "doctor" ]; then
  command -v bun >/dev/null || { echo "hubert: bun is required for doctor (https://bun.sh)" >&2; exit 1; }
  exec bun doctor.ts
fi
# Without a terminal, surface errors as a notification and in the log.
if [ ! -t 2 ] && [ "${1:-}" != "ptt" ]; then
  ERRLOG="${XDG_STATE_HOME:-$HOME/.local/state}/hubert-launch.log"
  mkdir -p "$(dirname "$ERRLOG")"
  exec 2>"$ERRLOG"
  trap 'rc=$?; [ $rc -ne 0 ] && command -v notify-send >/dev/null && notify-send "Hubert failed to start" "$(tail -n 3 "$ERRLOG")"' EXIT
fi
PORT="${HUBERT_PORT:-7777}"
URL="http://127.0.0.1:$PORT"
up() { curl -fs "$URL/api/state" >/dev/null 2>&1; }

# Global push-to-talk for a window manager bind: `hubert.sh ptt start|stop|toggle`.
if [ "${1:-}" = "ptt" ]; then
  action="${2:-toggle}"
  case "$action" in start|stop|toggle) ;; *) echo "usage: hubert.sh ptt start|stop|toggle" >&2; exit 2;; esac
  curl -fsS -X POST "$URL/api/ptt" -H 'content-type: application/json' --data "{\"action\":\"$action\"}" >/dev/null \
    || { echo "hubert: server is not running" >&2; exit 1; }
  exit 0
fi

started=0
if ! up; then
  command -v bun >/dev/null || { echo "hubert: bun is required (https://bun.sh)" >&2; exit 1; }
  [ -d node_modules ] || bun install --frozen-lockfile
  LOG="${XDG_STATE_HOME:-$HOME/.local/state}/hubert.log"
  mkdir -p "$(dirname "$LOG")"
  NODE_ENV=production nohup bun server.ts >"$LOG" 2>&1 &
  started=1
fi

# jcode harness bridge (lets Hubert interrupt jcode agents). Optional, skipped if jcode is missing.
SOCK="${JCODE_API_SOCKET:-${XDG_RUNTIME_DIR:-/tmp}/jcode-api.sock}"
if command -v jcode >/dev/null && [ ! -S "$SOCK" ]; then
  nohup jcode --quiet --no-update --no-selfdev api-bridge >/dev/null 2>&1 &
fi

# Native window (GTK4 + WebKitGTK). A second launch raises the existing window.
python3 -c 'import gi; gi.require_version("WebKit","6.0"); gi.require_version("Gtk","4.0")' 2>/dev/null \
  || { echo "hubert: needs PyGObject + WebKitGTK 6 (Fedora: sudo dnf install python3-gobject webkitgtk6.0)" >&2; exit 1; }
if command -v hyprctl >/dev/null && [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then
  addr=$(hyprctl clients -j | jq -r '.[] | select(.class=="dev.hubert.Hubert") | .address' | head -1)
  [ -n "$addr" ] && { hyprctl dispatch focuswindow "address:$addr" >/dev/null; exit 0; }
fi
# Window first: it shows a splash and connects once the server answers, so Python/GTK
# startup overlaps server startup instead of waiting for it.
HUBERT_PORT="$PORT" nohup python3 hubert-window.py >/dev/null 2>&1 &

if [ "$started" = 1 ]; then
  for _ in $(seq 50); do up && break; sleep 0.1; done
  up || { echo "hubert: server failed to start, see $LOG" >&2; exit 1; }
fi
