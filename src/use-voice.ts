import { useCallback, useEffect, useRef, useState } from "react";
import { createVoiceRecorder, type VoiceState } from "./recording";

export type { VoiceState } from "./recording";
type Stt = { active: string | null; connectors: { id: string; label: string; kind: string; unavailable: string | null }[] };

export function useVoice(onText: (text: string, connector: string) => void, onError: (msg: string) => void) {
  const [state, setState] = useState<VoiceState>("idle");
  const [stt, setStt] = useState<Stt | null>(null);
  const recorder = useRef<ReturnType<typeof createVoiceRecorder> | null>(null);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };

  useEffect(() => {
    let active = true;
    recorder.current = createVoiceRecorder(setState, (text, connector) => callbacks.current.onText(text, connector), message => callbacks.current.onError(message));
    fetch("/api/stt").then(r => r.json() as Promise<Stt>).then(data => { if (active) setStt(data); }).catch(() => {});
    const cancel = () => recorder.current?.cancel();
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      active = false;
      recorder.current?.dispose(); recorder.current = null;
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);

  const start = useCallback(() => { void recorder.current?.start(); }, []);
  const stop = useCallback(() => recorder.current?.stop(), []);
  const cancel = useCallback(() => recorder.current?.cancel(), []);
  return { state, stt, start, stop, cancel };
}
