export type Preferences = { voiceMode: "hold" | "toggle"; shortcut: string | null };
export const DEFAULT_PREFERENCES: Preferences = { voiceMode: "hold", shortcut: "Space" };
export const PREFERENCES_KEY = "hubert.preferences";
export const validShortcut = (code: string) => /^(Space|Key[A-Z]|Digit[0-9]|F8|F9)$/.test(code);
export const shortcutLabel = (code: string | null) => code?.replace(/^(Key|Digit)/, "") ?? "None";

export function parsePreferences(raw: string | null): Preferences {
  let value: Partial<Preferences> = {};
  try { const parsed = JSON.parse(raw ?? "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed; } catch {}
  return {
    voiceMode: value.voiceMode === "toggle" ? "toggle" : "hold",
    shortcut: value.shortcut === null ? null : typeof value.shortcut === "string" && validShortcut(value.shortcut) ? value.shortcut : DEFAULT_PREFERENCES.shortcut,
  };
}
