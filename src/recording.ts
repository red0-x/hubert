export type VoiceState = "idle" | "starting" | "listening" | "transcribing";

/** Clips shorter than this are almost always an accidental tap, so they are dropped before upload. */
export const MIN_RECORDING_MS = 300;
/** Peak level (see normalizeLevel) below which a clip is treated as silence rather than speech. */
export const MIN_SPEECH_LEVEL = 0.05;

/** While holding, MediaRecorder emits a snapshot this often; a snapshot is the whole clip so far. */
export const PREVIEW_TIMESLICE_MS = 1000;
/** Smallest gap between preview requests; a long hold must not hammer whisper. */
export const PREVIEW_INTERVAL_MS = 1800;
/** Earliest a preview is worth asking for (whisper returns nothing for a tiny clip). */
export const PREVIEW_MIN_MS = 900;
/** Hard cap on previews per recording, bounding request count. */
export const MAX_PREVIEWS = 40;
/** Hard cap on one recording, bounding retained audio and whisper work. */
export const MAX_RECORDING_MS = 120_000;

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
 * onPreview receives provisional text from growing snapshots while the user is still holding; it is
 * UI-only and never a command. The only transcript that acts arrives through onText on release.
 * previewAllowed gates snapshots (e.g. only for a free local connector, never to bill a cloud STT).
 */
export function createVoiceRecorder(onState: (state: VoiceState) => void, onText: (text: string, connector: string, ms?: number) => void, onError: (message: string) => void, onLevel?: (level: number) => void, notReady?: () => string | null, onPreview?: (text: string) => void, previewAllowed?: () => boolean) {
  let state: VoiceState = "idle";
  let generation = 0;
  let disposed = false;
  let recorder: MediaRecorder | null = null;
  let releaseActive: (() => void) | null = null;
  let upload: AbortController | null = null;
  let previewAbort: AbortController | null = null;
  let previewInFlight: Promise<void> | null = null;
  let releasing = false;
  const update = (next: VoiceState) => { state = next; if (!disposed) onState(next); };

  async function start() {
    if (disposed || state !== "idle") return;
    const blocked = notReady?.();
    if (blocked) return onError(blocked);
    if (!navigator.mediaDevices?.getUserMedia) return onError("Microphone is not available in this window");
    const id = ++generation;
    releasing = false;
    update("starting");
    let release: (() => void) | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let released = false;
      let stopLevel = () => {};
      const startedAt = Date.now();
      let peak = 0; // loudest sample seen, used as a cheap VAD
      let metered = false;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let previewAt = 0;
      let previews = 0;
      const onSample = (level: number) => { if (level > peak) peak = level; onLevel?.(level); };
      release = () => { if (!released) { released = true; stopLevel(); if (stopTimer) clearTimeout(stopTimer); stream.getTracks().forEach(t => t.stop()); } };
      if (disposed || id !== generation) { release(); return; }
      releaseActive = release;
      const r = new MediaRecorder(stream);
      const type = () => r.mimeType || "audio/webm";
      const chunks: Blob[] = [];
      // One cumulative preview at a time: the whole clip so far is a decodable prefix of the same
      // MediaRecorder stream, and the warm whisper socket serves one request at a time.
      const preview = () => {
        if (!onPreview || (previewAllowed && !previewAllowed())) return;
        if (disposed || id !== generation || releasing || previewInFlight || state !== "listening") return;
        const now = Date.now();
        if (now - previewAt < PREVIEW_INTERVAL_MS || now - startedAt < PREVIEW_MIN_MS || previews >= MAX_PREVIEWS) return;
        if (!chunks.length) return;
        const blob = new Blob(chunks.slice(), { type: type() });
        if (blob.size < 2000) return;
        previewAt = now; previews++;
        const controller = new AbortController();
        previewAbort = controller;
        const pending = (async () => {
          try {
            const response = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": type() }, body: blob, signal: controller.signal });
            if (!response.ok) return;
            const result = await response.json() as { text?: string };
            if (disposed || id !== generation || releasing) return; // a late preview never overwrites the final
            const text = (result.text ?? "").trim();
            if (text) onPreview(text);
          } catch {
            // Best-effort: a dropped or failed preview is not the user's problem and never a final error.
          } finally {
            if (previewAbort === controller) previewAbort = null;
          }
        })();
        previewInFlight = pending;
        void pending.finally(() => { if (previewInFlight === pending) previewInFlight = null; });
      };
      r.ondataavailable = e => { if (e.data.size) chunks.push(e.data); preview(); };
      r.onstop = async () => {
        release!();
        if (recorder === r) { recorder = null; releaseActive = null; }
        if (disposed || id !== generation) return;
        // Never overlap the final upload with a preview: wait the last preview out first (it holds the socket).
        if (previewInFlight) { try { await previewInFlight; } catch {} }
        if (disposed || id !== generation) return;
        const blob = new Blob(chunks, { type: type() });
        if (Date.now() - startedAt < MIN_RECORDING_MS || blob.size < 2000) { update("idle"); onError("Recording too short, ignored. Hold the mic a little longer."); return; }
        if (metered && peak < MIN_SPEECH_LEVEL) { update("idle"); onError("Heard only silence. Check the input device and speak closer to the mic."); return; }
        update("transcribing");
        const controller = new AbortController();
        upload = controller;
        try {
          const response = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": type() }, body: blob, signal: controller.signal });
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
      r.start(PREVIEW_TIMESLICE_MS);
      stopTimer = setTimeout(() => { if (!disposed && id === generation && state === "listening") stop(); }, MAX_RECORDING_MS);
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
    else if (recorder?.state === "recording") { releasing = true; update("transcribing"); recorder.stop(); }
  }
  function cancel() {
    generation++;
    releasing = true;
    previewAbort?.abort(); previewAbort = null;
    previewInFlight = null;
    upload?.abort(); upload = null;
    releaseActive?.(); releaseActive = null;
    if (recorder?.state === "recording") recorder.stop();
    recorder = null;
    update("idle");
  }
  return { start, stop, cancel, dispose() { disposed = true; cancel(); } };
}
