export type VoiceState = "idle" | "starting" | "listening" | "transcribing";

/** Own microphone lifetime independently of pointer/key gestures and React rerenders. */
export function createVoiceRecorder(onState: (state: VoiceState) => void, onText: (text: string, connector: string) => void, onError: (message: string) => void) {
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
      release = () => { if (!released) { released = true; stream.getTracks().forEach(t => t.stop()); } };
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
