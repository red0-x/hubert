import { expect, test } from "bun:test";
import { DEFAULT_PREFERENCES, parsePreferences, shortcutLabel, validShortcut } from "./preferences";

test("preferences survive malformed or legacy storage without enabling unsupported behavior", () => {
  for (const raw of [null, "not json", "null", "[]", '{"voiceMode":"always-on","shortcut":"Escape"}'])
    expect(parsePreferences(raw)).toEqual(DEFAULT_PREFERENCES);
  expect(parsePreferences('{"voiceMode":"toggle","shortcut":"KeyV"}')).toEqual({ voiceMode: "toggle", shortcut: "KeyV" });
  expect(parsePreferences('{"shortcut":null}')).toEqual({ voiceMode: "hold", shortcut: null });
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
