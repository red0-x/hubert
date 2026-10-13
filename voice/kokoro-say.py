"""Text on stdin -> raw s16le mono PCM on stdout. argv: voice[:voice2...] speed. Run with the tts-venv python."""
import sys, os, numpy as np
from kokoro_onnx import Kokoro
d = os.path.join(os.path.expanduser("~"), ".local/share/hubert/kokoro")
k = Kokoro(os.path.join(d, "kokoro.onnx"), os.path.join(d, "voices.bin"))
names = sys.argv[1].split(":")
voice = k.get_voice_style(names[0]) if len(names) == 1 else np.mean([k.get_voice_style(n) for n in names], axis=0)  # blend styles
audio, sr = k.create(sys.stdin.read(), voice=voice, speed=float(sys.argv[2]), lang="en-us")
sys.stdout.buffer.write((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
