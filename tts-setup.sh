#!/bin/sh
# Optional: install the Piper neural voice Hubert uses for spoken replies (local, offline, ~60 MB).
set -e
D="$HOME/.local/share/hubert"; mkdir -p "$D/voices"
uv venv "$D/tts-venv" && uv pip install --python "$D/tts-venv/bin/python" piper-tts
"$D/tts-venv/bin/python" -m piper.download_voices "${1:-en_GB-jenny_dioco-medium}" --download-dir "$D/voices"
# Kokoro: a small (92 MB), much more natural voice. Preferred over Piper when installed.
uv pip install --python "$D/tts-venv/bin/python" kokoro-onnx soundfile
mkdir -p "$D/kokoro"
R=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
curl -fsSL -o "$D/kokoro/kokoro.onnx" "$R/kokoro-v1.0.int8.onnx"
curl -fsSL -o "$D/kokoro/voices.bin" "$R/voices-v1.0.bin"
