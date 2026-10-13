// Read voice replies aloud with the browser's built-in speech synthesis. No dependency.
// WebKitGTK may lack speechSynthesis; speechDiagnostic() explains that instead of silently
// pretending the feature exists.

import type { Preferences } from "./preferences";
import { SPEAK_PITCH_DEFAULT, SPEAK_RATE_DEFAULT, clampSpeechPitch, clampSpeechRate } from "./preferences";

export type SpeechVoice = { name: string; lang: string; voiceURI?: string; default?: boolean; localService?: boolean };

export type SpeechUtterance = { text: string; voice?: SpeechVoice | null; pitch?: number; rate?: number; lang?: string };

export type SpeechGlobal = {
  speechSynthesis?: {
    speak(utterance: unknown): void;
    cancel?(): void;
    getVoices?(): SpeechVoice[];
    addEventListener?(type: string, listener: () => void): void;
    removeEventListener?(type: string, listener: () => void): void;
  };
  SpeechSynthesisUtterance?: new (text: string) => SpeechUtterance;
};

const defaultGlobal = (): SpeechGlobal | undefined => (typeof window === "undefined" ? undefined : (window as unknown as SpeechGlobal));

/** A yes/no for feature detection. Prefer speechDiagnostic() when the user needs to know why. */
export function speechSupported(g: SpeechGlobal | undefined = defaultGlobal()): boolean {
  return !!g && typeof g.speechSynthesis?.speak === "function" && typeof g.SpeechSynthesisUtterance === "function";
}

/** Human-readable reason speech is unavailable, or null when it works. Shown in Settings. */
export function speechDiagnostic(g: SpeechGlobal | undefined = defaultGlobal()): string | null {
  if (!g) return "Spoken replies need the Hubert window.";
  if (typeof g.SpeechSynthesisUtterance !== "function") return "Spoken replies are unavailable: this build exposes no SpeechSynthesisUtterance.";
  if (typeof g.speechSynthesis?.speak !== "function") return "Spoken replies are unavailable: this WebKit build does not provide speech synthesis.";
  return null;
}

/** Installed voices reported by the engine. Listed verbatim, never classified by name. */
export function listVoices(g: SpeechGlobal | undefined = defaultGlobal()): SpeechVoice[] {
  try {
    const voices = g?.speechSynthesis?.getVoices?.() ?? [];
    return voices.filter((v) => v && typeof v.name === "string" && v.name.trim().length > 0 && typeof v.lang === "string");
  } catch { return []; }
}

export type SpeakKind = "answer" | "ack" | "alert";

/** Longest spoken action acknowledgement, in words. */
export const ACK_MAX_WORDS = 8;
/** Answers above these bounds are treated as large output/transcripts and are not read. */
export const ANSWER_MAX_CHARS = 600;
export const ANSWER_MAX_LINES = 6;
/** Same text re-requested inside this window is treated as a duplicate reply. */
export const DUPLICATE_WINDOW_MS = 4000;

/**
 * Pure policy: what (if anything) should be read aloud for this text and kind.
 * acks are clipped short; long answers (command output, transcripts) are refused.
 */
export function speakableText(text: string, kind: SpeakKind = "answer"): string | null {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (kind === "ack" || kind === "alert") {
    const words = collapsed.split(" ");
    return words.length <= ACK_MAX_WORDS ? collapsed : `${words.slice(0, ACK_MAX_WORDS).join(" ")}…`;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  if (collapsed.length > ANSWER_MAX_CHARS || lines > ANSWER_MAX_LINES) return null;
  return collapsed;
}

// Per-global dedupe state so tests with fresh globals stay isolated.
const lastSpoken = new WeakMap<object, { text: string; at: number }>();

let listening = false;

/** Mute speech while the mic is open. Switching it on also cancels anything playing. */
export function setSpeechListening(on: boolean, g: SpeechGlobal | undefined = defaultGlobal()): void {
  listening = on;
  if (on) stopSpeech(g);
}

export function speechListening(): boolean { return listening; }

/** Cancel any in-flight utterance. Safe where speech is unsupported. */
export function stopSpeech(g: SpeechGlobal | undefined = defaultGlobal()): void {
  try { g?.speechSynthesis?.cancel?.(); } catch {}
}

export type SpeakOptions = { kind?: SpeakKind; pitch?: number; rate?: number; voice?: string | null; now?: number };

function resolveVoice(g: SpeechGlobal, wanted: string | null | undefined): SpeechVoice | undefined {
  if (!wanted) return undefined;
  return listVoices(g).find((v) => v.voiceURI === wanted || v.name === wanted);
}

/**
 * Speak text, applying the policy and settings. Does nothing when unsupported, while the mic is
 * open, when the text is empty/unreadable, or when it was already spoken a moment ago.
 */
export function speak(text: string, g: SpeechGlobal | undefined = defaultGlobal(), opts: SpeakOptions = {}): void {
  const chosen = speakableText(text, opts.kind ?? "answer");
  if (!chosen || !g || !speechSupported(g) || listening) return;
  const now = opts.now ?? Date.now();
  const prev = lastSpoken.get(g as object);
  if (prev && prev.text === chosen && now - prev.at < DUPLICATE_WINDOW_MS) return;
  lastSpoken.set(g as object, { text: chosen, at: now });
  try {
    g.speechSynthesis!.cancel?.();
    const utterance = new g.SpeechSynthesisUtterance!(chosen);
    utterance.pitch = clampSpeechPitch(opts.pitch ?? SPEAK_PITCH_DEFAULT);
    utterance.rate = clampSpeechRate(opts.rate ?? SPEAK_RATE_DEFAULT);
    const voice = resolveVoice(g, opts.voice);
    if (voice) utterance.voice = voice;
    g.speechSynthesis!.speak(utterance);
  } catch {}
}

/** Speak a reply using the user's saved voice/pitch/rate. Callers gate on the speakReplies opt-in. */
export function speakReply(
  text: string,
  kind: SpeakKind,
  prefs?: Pick<Preferences, "speakVoice" | "speakPitch" | "speakRate">,
  g: SpeechGlobal | undefined = defaultGlobal(),
): void {
  speak(text, g, { kind, voice: prefs?.speakVoice, pitch: prefs?.speakPitch, rate: prefs?.speakRate });
}
