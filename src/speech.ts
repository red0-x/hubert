// Read voice replies aloud with the browser's built-in speech synthesis. No dependency.
// WebKitGTK may lack speechSynthesis; callers hide the setting when speechSupported() is false.

type SpeechGlobal = {
  speechSynthesis?: { speak(utterance: unknown): void; cancel?: () => void };
  SpeechSynthesisUtterance?: new (text: string) => unknown;
};

const defaultGlobal = (): SpeechGlobal | undefined => (typeof window === "undefined" ? undefined : (window as unknown as SpeechGlobal));

export function speechSupported(g: SpeechGlobal | undefined = defaultGlobal()): boolean {
  return !!g && typeof g.speechSynthesis?.speak === "function" && typeof g.SpeechSynthesisUtterance === "function";
}

/** Speak text, interrupting any reply already being read. Does nothing where unsupported. */
export function speak(text: string, g: SpeechGlobal | undefined = defaultGlobal()): void {
  const t = text.trim();
  if (!t || !g || !speechSupported(g)) return;
  try {
    g.speechSynthesis?.cancel?.();
    g.speechSynthesis?.speak(new g.SpeechSynthesisUtterance!(t));
  } catch {}
}
