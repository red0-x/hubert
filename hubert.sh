#!/usr/bin/env bash
# Start hubert server (if not running) and open/focus the side window.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
PORT="${HUBERT_PORT:-7777}"
URL="http://127.0.0.1:$PORT"

if ! curl -fs "$URL/api/state" >/dev/null 2>&1; then
  NODE_ENV=production nohup bun server.ts >"${XDG_STATE_HOME:-$HOME/.local/state}/hubert.log" 2>&1 &
  for _ in $(seq 50); do curl -fs "$URL/api/state" >/dev/null 2>&1 && break; sleep 0.1; done
fi

# Brave on Wayland ignores --class; app windows get class brave-<host>__-Default
CLASS="brave-127.0.0.1__-Default"
if hyprctl clients -j | jq -e --arg c "$CLASS" '.[] | select(.class == $c)' >/dev/null; then
  hyprctl dispatch focuswindow "class:^$CLASS\$" >/dev/null
else
  brave-browser --app="$URL" --user-data-dir="$HOME/.cache/hubert-brave" >/dev/null 2>&1 &
fi
