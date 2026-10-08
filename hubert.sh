#!/usr/bin/env bash
# Start the hubert server (if not running) and open/focus the dashboard window.
#   HUBERT_PORT     port (default 7777)
#   HUBERT_BROWSER  browser binary to use in --app mode (default: first Chromium-family browser found)
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

# Chromium-family browsers on Wayland name app windows "<browser>-<host>__-Default".
if command -v hyprctl >/dev/null && [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then
  addr=$(hyprctl clients -j | jq -r '.[] | select(.class | endswith("-127.0.0.1__-Default")) | .address' | head -1)
  [ -n "$addr" ] && { hyprctl dispatch focuswindow "address:$addr" >/dev/null; exit 0; }
fi

for b in ${HUBERT_BROWSER:-} chromium google-chrome-stable google-chrome brave-browser brave microsoft-edge-stable vivaldi; do
  if command -v "$b" >/dev/null; then
    "$b" --app="$URL" --user-data-dir="${XDG_CACHE_HOME:-$HOME/.cache}/hubert-browser" >/dev/null 2>&1 &
    exit 0
  fi
done
echo "hubert: no Chromium-family browser found, opening $URL in your default browser"
xdg-open "$URL" 2>/dev/null || open "$URL"
