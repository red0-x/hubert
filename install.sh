#!/usr/bin/env bash
# Install a user-level desktop launcher for Hubert. Writes only under ~/.local/share
# and does not start Hubert or anything else.
#   ./install.sh              install
#   ./install.sh --uninstall  remove
set -euo pipefail

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"
DEST="$APPS/hubert.desktop"

refresh() {
  command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f -t "$(dirname "$(dirname "$ICONS")")" >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$DEST" "$ICONS/hubert.png"
  refresh
  echo "hubert: removed $DEST"
  exit 0
fi

[ -f "$DIR/hubert.desktop" ] || { echo "hubert: hubert.desktop not found next to this script" >&2; exit 1; }
chmod +x "$DIR/hubert.sh" 2>/dev/null || true
mkdir -p "$APPS" "$ICONS"
sed "s|@HUBERT_DIR@|$DIR|g" "$DIR/hubert.desktop" > "$DEST"
cp "$DIR/docs/icon.png" "$ICONS/hubert.png"
command -v desktop-file-validate >/dev/null && desktop-file-validate "$DEST" >/dev/null 2>&1 || true
refresh

echo "hubert: installed $DEST"
echo "launch it from your app menu, or run: $DIR/hubert.sh"
