export type VoiceState = "idle" | "starting" | "listening" | "transcribing";

/** Clips shorter than this are almost always an accidental tap, so they are dropped before upload. */
export const MIN_RECORDING_MS = 300;
/** Peak level (see normalizeLevel) below which a clip is treated as silence rather than speech. */
export const MIN_SPEECH_LEVEL = 0.05;

/** getUserMedia failures turn into something a human can act on. */
export function micError(error: unknown): string {
  const e = error as { name?: string; message?: string } | null;
  switch (e?.name) {
    case "NotAllowedError":
    case "SecurityError": return "Microphone blocked. Allow microphone access for Hubert, then try again.";
    case "NotFoundError":
    case "DevicesNotFoundError": return "No microphone found. Plug one in and try again.";
    case "NotReadableError":
    case "TrackStartError": return "Microphone is busy in another app. Close it and try again.";
    case "OverconstrainedError": return "This microphone does not support the requested audio settings.";
    case "AbortError": return "Microphone access was interrupted. Try again.";
    default: return e?.message || "Could not start the microphone.";
  }
}

/** RMS of 8-bit time-domain samples mapped to a rough 0..1 meter. Boosted so normal speech fills it. */
export function normalizeLevel(samples: Uint8Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const s of samples) { const v = (s - 128) / 128; sum += v * v; }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3);
}

type AudioCtor = new () => AudioContext;

/** Level meter: cosmetic (the meter, and the silence check) but never allowed to break recording. */
function attachLevelMeter(stream: MediaStream, onLevel?: (level: number) => void): { stop: () => void; metered: boolean } {
  if (!onLevel) return { stop: () => {}, metered: false };
  const g = globalThis as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const Ctx = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctx || typeof requestAnimationFrame !== "function") return { stop: () => {}, metered: false };
  let context: AudioContext | null = null;
  let frame = 0;
  try {
    context = new Ctx();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      onLevel(normalizeLevel(samples));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  } catch {
    void context?.close().catch(() => {});
    onLevel(0);
    return { stop: () => {}, metered: false };
  }
  return {
    metered: true,
    stop: () => {
      if (frame) cancelAnimationFrame(frame);
      try { void context?.close(); } catch {}
      onLevel(0);
    },
  };
}

/**
 * Own microphone lifetime independently of pointer/key gestures and React rerenders.
 * notReady() returns a message when recording must not start at all (e.g. no speech connector configured).
 */
export function createVoiceRecorder(onState: (state: VoiceState) => void, onText: (text: string, connector: string, ms?: number) => void, onError: (message: string) => void, onLevel?: (level: number) => void, notReady?: () => string | null) {
  let state: VoiceState = "idle";
  let generation = 0;
  let disposed = false;
  let recorder: MediaRecorder | null = null;
  let releaseActive: (() => void) | null = null;
  let upload: AbortController | null = null;
  const update = (next: VoiceState) => { state = next; if (!disposed) onState(next); };

  async function start() {
    if (disposed || state !== "idle") return;
    const blocked = notReady?.();
    if (blocked) return onError(blocked);
    if (!navigator.mediaDevices?.getUserMedia) return onError("Microphone is not available in this window");
    const id = ++generation;
    update("starting");
    let release: (() => void) | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let released = false;
      let stopLevel = () => {};
      const startedAt = Date.now();
      let peak = 0; // loudest sample seen, used as a cheap VAD
      let metered = false;
      const onSample = (level: number) => { if (level > peak) peak = level; onLevel?.(level); };
      release = () => { if (!released) { released = true; stopLevel(); stream.getTracks().forEach(t => t.stop()); } };
      if (disposed || id !== generation) { release(); return; }
      releaseActive = release;
      const r = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      r.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      r.onstop = async () => {
        release!();
        if (recorder === r) { recorder = null; releaseActive = null; }
        if (disposed || id !== generation) return;
        const blob = new Blob(chunks, { type: r.mimeType });
        if (Date.now() - startedAt < MIN_RECORDING_MS || blob.size < 2000) { update("idle"); onError("Recording too short, ignored. Hold the mic a little longer."); return; }
        if (metered && peak < MIN_SPEECH_LEVEL) { update("idle"); onError("Heard only silence. Check the input device and speak closer to the mic."); return; }
        update("transcribing");
        const controller = new AbortController();
        upload = controller;
        try {
          const response = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": r.mimeType || "audio/webm" }, body: blob, signal: controller.signal });
          if (!response.ok) throw new Error(`transcription failed (${response.status}): ${await response.text()}`);
          const result = await response.json() as { text: string; connector: string; ms?: number };
          if (disposed || id !== generation) return;
          if (result.text) onText(result.text, result.connector, result.ms);
          else onError("Heard nothing. Try again closer to the microphone.");
        } catch (error) {
          if (!disposed && id === generation) onError(error instanceof TypeError ? "hubert server is not reachable" : (error as Error).message);
        } finally {
          if (upload === controller) upload = null;
          if (!disposed && id === generation) update("idle");
        }
      };
      recorder = r;
      r.start();
      const meter = attachLevelMeter(stream, onSample);
      stopLevel = meter.stop;
      metered = meter.metered;
      update("listening");
    } catch (error) {
      release?.();
      if (id !== generation || disposed) return;
      recorder = null; releaseActive = null;
      update("idle");
      onError(micError(error));
    }
  }

  function stop() {
    if (state === "starting") { generation++; update("idle"); }
    else if (recorder?.state === "recording") { update("transcribing"); recorder.stop(); }
  }
  function cancel() {
    generation++;
    upload?.abort(); upload = null;
    releaseActive?.(); releaseActive = null;
    if (recorder?.state === "recording") recorder.stop();
    recorder = null;
    update("idle");
  }
  return { start, stop, cancel, dispose() { disposed = true; cancel(); } };
}
