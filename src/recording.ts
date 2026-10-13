export type VoiceState = "idle" | "starting" | "listening" | "transcribing";

/** RMS of 8-bit time-domain samples mapped to a rough 0..1 meter. Boosted so normal speech fills it. */
export function normalizeLevel(samples: Uint8Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const s of samples) { const v = (s - 128) / 128; sum += v * v; }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3);
}

type AudioCtor = new () => AudioContext;

/** Cosmetic level meter: never allowed to break recording. Returns a cleanup function. */
function attachLevelMeter(stream: MediaStream, onLevel?: (level: number) => void): () => void {
  if (!onLevel) return () => {};
  const g = globalThis as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const Ctx = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctx || typeof requestAnimationFrame !== "function") return () => {};
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
    return () => {};
  }
  return () => {
    if (frame) cancelAnimationFrame(frame);
    try { void context?.close(); } catch {}
    onLevel(0);
  };
}

/** Own microphone lifetime independently of pointer/key gestures and React rerenders. */
export function createVoiceRecorder(onState: (state: VoiceState) => void, onText: (text: string, connector: string) => void, onError: (message: string) => void, onLevel?: (level: number) => void) {
  let state: VoiceState = "idle";
  let generation = 0;
  let disposed = false;
  let recorder: MediaRecorder | null = null;
  let releaseActive: (() => void) | null = null;
  let upload: AbortController | null = null;
  const update = (next: VoiceState) => { state = next; if (!disposed) onState(next); };

  async function start() {
    if (disposed || state !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia) return onError("Microphone is not available in this window");
    const id = ++generation;
    update("starting");
    let release: (() => void) | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let released = false;
      let stopLevel = () => {};
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
        if (blob.size < 2000) { update("idle"); return; }
        update("transcribing");
        const controller = new AbortController();
        upload = controller;
        try {
          const response = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": r.mimeType || "audio/webm" }, body: blob, signal: controller.signal });
          if (!response.ok) throw new Error(await response.text());
          const result = await response.json() as { text: string; connector: string };
          if (disposed || id !== generation) return;
          if (result.text) onText(result.text, result.connector);
          else onError("Heard nothing");
        } catch (error) {
          if (!disposed && id === generation) onError((error as Error).message);
        } finally {
          if (upload === controller) upload = null;
          if (!disposed && id === generation) update("idle");
        }
      };
      recorder = r;
      r.start();
      stopLevel = attachLevelMeter(stream, onLevel);
      update("listening");
    } catch (error) {
      release?.();
      if (id !== generation || disposed) return;
      recorder = null; releaseActive = null;
      update("idle");
      onError((error as Error).message || "Microphone permission denied");
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
