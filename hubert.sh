#!/usr/bin/env bash
# Start the hubert server (if not running) and open/focus the native dashboard window.
#   HUBERT_PORT     port (default 7777)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
PORT="${HUBERT_PORT:-7777}"
URL="http://127.0.0.1:$PORT"
up() { curl -fs "$URL/api/state" >/dev/null 2>&1; }

if ! up; then
  command -v bun >/dev/null || { echo "hubert: bun is required (https://bun.sh)" >&2; exit 1; }
  [ -d node_modules ] || bun install --frozen-lockfile
  LOG="${XDG_STATE_HOME:-$HOME/.local/state}/hubert.log"
  mkdir -p "$(dirname "$LOG")"
  NODE_ENV=production nohup bun server.ts >"$LOG" 2>&1 &
  for _ in $(seq 50); do up && break; sleep 0.1; done
  up || { echo "hubert: server failed to start, see $LOG" >&2; exit 1; }
fi

# Native window (GTK4 + WebKitGTK). A second launch raises the existing window.
python3 -c 'import gi; gi.require_version("WebKit","6.0"); gi.require_version("Gtk","4.0")' 2>/dev/null \
  || { echo "hubert: needs PyGObject + WebKitGTK 6 (Fedora: sudo dnf install python3-gobject webkitgtk6.0)" >&2; exit 1; }
if command -v hyprctl >/dev/null && [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then
  addr=$(hyprctl clients -j | jq -r '.[] | select(.class=="dev.hubert.Hubert") | .address' | head -1)
  [ -n "$addr" ] && { hyprctl dispatch focuswindow "address:$addr" >/dev/null; exit 0; }
fi
HUBERT_PORT="$PORT" nohup python3 hubert-window.py >/dev/null 2>&1 &
