import { useCallback, useEffect, useRef, useState } from "react";
import { createVoiceRecorder, type VoiceState } from "./recording";

export type { VoiceState } from "./recording";
type Stt = { active: string | null; connectors: { id: string; label: string; kind: string; unavailable: string | null }[] };

export function useVoice(onText: (text: string, connector: string, ms?: number) => void, onError: (msg: string) => void) {
  const [state, setState] = useState<VoiceState>("idle");
  const [level, setLevel] = useState(0);
  const [draft, setDraft] = useState("");
  const [stt, setStt] = useState<Stt | null>(null);
  const recorder = useRef<ReturnType<typeof createVoiceRecorder> | null>(null);
  const pttActive = useRef(false);
  const sttRef = useRef<Stt | null>(null);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };

  useEffect(() => {
    let active = true;
    recorder.current = createVoiceRecorder(
      // A new hold starts a clean draft; a stale preview must never show against fresh audio.
      (s) => { if (s === "starting") setDraft(""); setState(s); },
      (text, connector, ms) => callbacks.current.onText(text, connector, ms),
      message => callbacks.current.onError(message),
      setLevel,
      // Refuse to open the mic when nothing can transcribe it, instead of recording into the void.
      () => (sttRef.current?.active ? null : "No speech connector configured. Set HUBERT_STT (see README) and restart Hubert."),
      // Provisional text only updates the UI; the final transcript still goes through onText once.
      setDraft,
      // Live previews are free chat with a local whisper; never quietly bill a cloud STT per snapshot.
      () => sttRef.current?.connectors.find((c) => c.id === sttRef.current?.active)?.kind === "local",
    );
    fetch("/api/stt").then(r => r.json() as Promise<Stt>).then(data => { sttRef.current = data; if (active) setStt(data); }).catch(() => {});
    // Global hotkey: the server owns start/stop so it works while the window is not focused.
    const events = new EventSource("/api/ptt/events");
    events.onmessage = (event) => {
      if (event.data === "recording") { if (!pttActive.current) { pttActive.current = true; void recorder.current?.start(); } }
      else if (pttActive.current) { pttActive.current = false; recorder.current?.stop(); }
    };
    // A push-to-talk recording must survive the window losing focus; in-app recording still cancels.
    const cancel = () => { if (!pttActive.current) recorder.current?.cancel(); };
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      active = false;
      events.close();
      recorder.current?.dispose(); recorder.current = null;
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);

  const start = useCallback(() => { void recorder.current?.start(); }, []);
  const stop = useCallback(() => recorder.current?.stop(), []);
  const cancel = useCallback(() => recorder.current?.cancel(), []);
  return { state, level, draft, stt, start, stop, cancel };
}
