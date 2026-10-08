import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceState = "idle" | "listening" | "transcribing";
type Stt = { active: string | null; connectors: { id: string; label: string; kind: string; unavailable: string | null }[] };

/** Hold-to-talk style recorder: start() opens the mic, stop() uploads and resolves the transcript. */
export function useVoice(onText: (text: string, connector: string) => void, onError: (msg: string) => void) {
  const [state, setState] = useState<VoiceState>("idle");
  const [stt, setStt] = useState<Stt | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  useEffect(() => {
    fetch("/api/stt")
      .then((r) => r.json() as Promise<Stt>)
      .then(setStt)
      .catch(() => {});
  }, []);

  const start = useCallback(async () => {
    if (rec.current) return;
    if (!navigator.mediaDevices?.getUserMedia) return onError("Microphone is not available in this window");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return onError("Microphone permission denied");
    }
    const r = new MediaRecorder(stream);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      rec.current = null;
      const blob = new Blob(chunks.current, { type: r.mimeType });
      if (blob.size < 2000) return setState("idle"); // accidental tap
      setState("transcribing");
      try {
        const res = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": r.mimeType || "audio/webm" }, body: blob });
        if (!res.ok) throw new Error(await res.text());
        const j = (await res.json()) as { text: string; connector: string };
        if (j.text) onText(j.text, j.connector);
        else onError("Heard nothing");
      } catch (e) {
        onError((e as Error).message);
      } finally {
        setState("idle");
      }
    };
    rec.current = r;
    r.start();
    setState("listening");
  }, [onText, onError]);

  const stop = useCallback(() => rec.current?.state === "recording" && rec.current.stop(), []);
  return { state, stt, start, stop };
}
