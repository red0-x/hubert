#!/bin/sh
# Optional: install the Piper neural voice Hubert uses for spoken replies (local, offline, ~60 MB).
set -e
D="$HOME/.local/share/hubert"; mkdir -p "$D/voices"
uv venv "$D/tts-venv" && uv pip install --python "$D/tts-venv/bin/python" piper-tts
"$D/tts-venv/bin/python" -m piper.download_voices "${1:-en_GB-jenny_dioco-medium}" --download-dir "$D/voices"
