import { expect, test } from "bun:test";
import { DEFAULT_PREFERENCES, SPEAK_PITCH_DEFAULT, SPEAK_PITCH_MAX, SPEAK_PITCH_MIN, SPEAK_RATE_DEFAULT, parsePreferences, shortcutLabel, validShortcut } from "./preferences";

test("preferences survive malformed or legacy storage without enabling unsupported behavior", () => {
  for (const raw of [null, "not json", "null", "[]", '{"voiceMode":"always-on","shortcut":"Escape"}'])
    expect(parsePreferences(raw)).toEqual(DEFAULT_PREFERENCES);
  expect(parsePreferences('{"voiceMode":"toggle","shortcut":"KeyV"}')).toEqual({ ...DEFAULT_PREFERENCES, voiceMode: "toggle", shortcut: "KeyV" });
  expect(parsePreferences('{"shortcut":null}')).toEqual({ ...DEFAULT_PREFERENCES, shortcut: null });
});

test("speak replies default off and only persist as a strict boolean", () => {
  expect(parsePreferences(null).speakReplies).toBe(false);
  expect(parsePreferences('{"speakReplies":"yes"}').speakReplies).toBe(false);
  expect(parsePreferences('{"speakReplies":1}').speakReplies).toBe(false);
  expect(parsePreferences('{"voiceMode":"toggle"}').speakReplies).toBe(false);
  expect(parsePreferences('{"speakReplies":true}').speakReplies).toBe(true);
  expect(parsePreferences('{"speakReplies":true,"voiceMode":"toggle","shortcut":"KeyV"}')).toEqual({ ...DEFAULT_PREFERENCES, speakReplies: true, voiceMode: "toggle", shortcut: "KeyV" });
});

test("desktop alerts default off and only persist as a strict boolean", () => {
  expect(parsePreferences(null).notifyAlerts).toBe(false);
  expect(parsePreferences('{"notifyAlerts":"yes"}').notifyAlerts).toBe(false);
  expect(parsePreferences('{"notifyAlerts":1}').notifyAlerts).toBe(false);
  expect(parsePreferences('{"notifyAlerts":true}').notifyAlerts).toBe(true);
});

test("speech pitch and rate are clamped at the trust boundary", () => {
  expect(parsePreferences(null).speakPitch).toBe(SPEAK_PITCH_DEFAULT);
  expect(parsePreferences(null).speakRate).toBe(SPEAK_RATE_DEFAULT);
  expect(parsePreferences("{\"speakPitch\":\"high\"}").speakPitch).toBe(SPEAK_PITCH_DEFAULT);
  expect(parsePreferences('{"speakPitch":null}').speakPitch).toBe(SPEAK_PITCH_DEFAULT);
  expect(parsePreferences('{"speakPitch":99}').speakPitch).toBe(SPEAK_PITCH_MAX);
  expect(parsePreferences('{"speakPitch":-3}').speakPitch).toBe(SPEAK_PITCH_MIN);
  expect(parsePreferences('{"speakPitch":1.35}').speakPitch).toBe(1.35);
  expect(parsePreferences('{"speakRate":1e9}').speakRate).toBe(2);
  expect(parsePreferences('{"speakRate":0}').speakRate).toBe(0.5);
});

test("voice selection persists only a non-empty bounded string, never a guess", () => {
  expect(parsePreferences(null).speakVoice).toBeNull();
  expect(parsePreferences('{"speakVoice":""}').speakVoice).toBeNull();
  expect(parsePreferences('{"speakVoice":"   "}').speakVoice).toBeNull();
  expect(parsePreferences('{"speakVoice":7}').speakVoice).toBeNull();
  expect(parsePreferences(`{"speakVoice":"${"x".repeat(201)}"}`).speakVoice).toBeNull();
  expect(parsePreferences('{"speakVoice":"daniel"}').speakVoice).toBe("daniel");
});

test("shortcut capture accepts deliberate non-modifier keys and displays readable labels", () => {
  expect(validShortcut("KeyV")).toBe(true);
  expect(validShortcut("F9")).toBe(true);
  expect(validShortcut("Escape")).toBe(false);
  expect(validShortcut("ControlLeft")).toBe(false);
  expect(shortcutLabel("KeyV")).toBe("V");
  expect(shortcutLabel("Space")).toBe("Space");
  expect(shortcutLabel(null)).toBe("None");
});
