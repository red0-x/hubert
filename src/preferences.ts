export type Preferences = {
  voiceMode: "hold" | "toggle";
  shortcut: string | null;
  speakReplies: boolean;
  notifyAlerts: boolean;
  /** Installed voice chosen by voiceURI (or name fallback). null = engine default. Never guessed from the name. */
  speakVoice: string | null;
  /** Playback pitch. Bounded so a malformed stored value cannot make Hubert unlistenable. */
  speakPitch: number;
  /** Playback rate. Bounded, same reason. */
  speakRate: number;
};

export const SPEAK_PITCH_MIN = 0.5;
export const SPEAK_PITCH_MAX = 2;
export const SPEAK_PITCH_DEFAULT = 1.5;
export const SPEAK_RATE_MIN = 0.5;
export const SPEAK_RATE_MAX = 2;
export const SPEAK_RATE_DEFAULT = 1;

export const DEFAULT_PREFERENCES: Preferences = {
  voiceMode: "hold",
  shortcut: "Space",
  speakReplies: false,
  notifyAlerts: false,
  speakVoice: null,
  speakPitch: SPEAK_PITCH_DEFAULT,
  speakRate: SPEAK_RATE_DEFAULT,
};

export const PREFERENCES_KEY = "hubert.preferences";
export const validShortcut = (code: string) => /^(Space|Key[A-Z]|Digit[0-9]|F8|F9)$/.test(code);
export const shortcutLabel = (code: string | null) => code?.replace(/^(Key|Digit)/, "") ?? "None";

/** Clamp to [min, max]; anything not a finite number becomes the default. */
export const clampSpeechPitch = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(SPEAK_PITCH_MAX, Math.max(SPEAK_PITCH_MIN, v)) : SPEAK_PITCH_DEFAULT);
export const clampSpeechRate = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(SPEAK_RATE_MAX, Math.max(SPEAK_RATE_MIN, v)) : SPEAK_RATE_DEFAULT);

export function parsePreferences(raw: string | null): Preferences {
  let value: Partial<Preferences> = {};
  try { const parsed = JSON.parse(raw ?? "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed; } catch {}
  return {
    voiceMode: value.voiceMode === "toggle" ? "toggle" : "hold",
    shortcut: value.shortcut === null ? null : typeof value.shortcut === "string" && validShortcut(value.shortcut) ? value.shortcut : DEFAULT_PREFERENCES.shortcut,
    speakReplies: value.speakReplies === true,
    notifyAlerts: value.notifyAlerts === true,
    speakVoice: typeof value.speakVoice === "string" && value.speakVoice.trim().length > 0 && value.speakVoice.length <= 200 ? value.speakVoice : null,
    speakPitch: clampSpeechPitch(value.speakPitch),
    speakRate: clampSpeechRate(value.speakRate),
  };
}
