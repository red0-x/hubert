import { expect, test } from "bun:test";
import { DEFAULT_PREFERENCES, parsePreferences, shortcutLabel, validShortcut } from "./preferences";

test("preferences survive malformed or legacy storage without enabling unsupported behavior", () => {
  for (const raw of [null, "not json", "null", "[]", '{"voiceMode":"always-on","shortcut":"Escape"}'])
    expect(parsePreferences(raw)).toEqual(DEFAULT_PREFERENCES);
  expect(parsePreferences('{"voiceMode":"toggle","shortcut":"KeyV"}')).toEqual({ voiceMode: "toggle", shortcut: "KeyV", speakReplies: false, notifyAlerts: false });
  expect(parsePreferences('{"shortcut":null}')).toEqual({ voiceMode: "hold", shortcut: null, speakReplies: false, notifyAlerts: false });
});

test("speak replies default off and only persist as a strict boolean", () => {
  expect(parsePreferences(null).speakReplies).toBe(false);
  expect(parsePreferences('{"speakReplies":"yes"}').speakReplies).toBe(false);
  expect(parsePreferences('{"speakReplies":1}').speakReplies).toBe(false);
  expect(parsePreferences('{"voiceMode":"toggle"}').speakReplies).toBe(false);
  expect(parsePreferences('{"speakReplies":true}').speakReplies).toBe(true);
  expect(parsePreferences('{"speakReplies":true,"voiceMode":"toggle","shortcut":"KeyV"}')).toEqual({ voiceMode: "toggle", shortcut: "KeyV", speakReplies: true, notifyAlerts: false });
});

test("desktop alerts default off and only persist as a strict boolean", () => {
  expect(parsePreferences(null).notifyAlerts).toBe(false);
  expect(parsePreferences('{"notifyAlerts":"yes"}').notifyAlerts).toBe(false);
  expect(parsePreferences('{"notifyAlerts":1}').notifyAlerts).toBe(false);
  expect(parsePreferences('{"notifyAlerts":true}').notifyAlerts).toBe(true);
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
