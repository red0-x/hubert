import { expect, test } from "bun:test";
import { isTypingElement, resolveKey } from "./keyboard";

test("number keys 1-5 map to panel indexes", () => {
  expect([1, 2, 3, 4, 5].map((n) => resolveKey({ key: String(n) }))).toEqual([
    { type: "panel", index: 0 },
    { type: "panel", index: 1 },
    { type: "panel", index: 2 },
    { type: "panel", index: 3 },
    { type: "panel", index: 4 },
  ]);
  expect(resolveKey({ key: "0" })).toBeNull();
  expect(resolveKey({ key: "6" })).toBeNull();
});

test("j/k move down and up, enter opens, slash filters, question help", () => {
  expect(resolveKey({ key: "j" })).toEqual({ type: "move", delta: 1 });
  expect(resolveKey({ key: "k" })).toEqual({ type: "move", delta: -1 });
  expect(resolveKey({ key: "Enter" })).toEqual({ type: "open" });
  expect(resolveKey({ key: "/" })).toEqual({ type: "filter" });
  expect(resolveKey({ key: "?" })).toEqual({ type: "help" });
});

test("typing or capturing a shortcut disables navigation keys", () => {
  for (const ctx of [{ typing: true }, { recording: true }]) {
    expect(resolveKey({ key: "1" }, ctx)).toBeNull();
    expect(resolveKey({ key: "j" }, ctx)).toBeNull();
    expect(resolveKey({ key: "?" }, ctx)).toBeNull();
    expect(resolveKey({ key: "/" }, ctx)).toBeNull();
  }
});

test("the configured voice shortcut is never stolen", () => {
  expect(resolveKey({ key: "1", code: "Digit1" }, { shortcut: "Digit1" })).toBeNull();
  expect(resolveKey({ key: "1", code: "Digit1" }, { shortcut: "KeyJ" })).toEqual({ type: "panel", index: 0 });
  // A shortcut with no event code provided cannot be matched, so the key still works.
  expect(resolveKey({ key: "j" }, { shortcut: "KeyJ" })).toEqual({ type: "move", delta: 1 });
});

test("modifier chords are left to the browser", () => {
  expect(resolveKey({ key: "j", ctrlKey: true })).toBeNull();
  expect(resolveKey({ key: "1", metaKey: true })).toBeNull();
  expect(resolveKey({ key: "Enter", altKey: true })).toBeNull();
});

test("escape only dismisses when an overlay is open", () => {
  expect(resolveKey({ key: "Escape" })).toBeNull();
  expect(resolveKey({ key: "Escape" }, { overlayOpen: true })).toEqual({ type: "dismiss" });
  expect(resolveKey({ key: "Escape" }, { overlayOpen: true, typing: true })).toEqual({ type: "dismiss" });
});

test("unhandled keys resolve to null", () => {
  expect(resolveKey({ key: "a" })).toBeNull();
  expect(resolveKey({ key: "Tab" })).toBeNull();
});

test("isTypingElement detects fields, contenteditable, and descendants", () => {
  expect(isTypingElement(null)).toBe(false);
  expect(isTypingElement({ tagName: "BUTTON" })).toBe(false);
  expect(isTypingElement({ tagName: "INPUT" })).toBe(true);
  expect(isTypingElement({ tagName: "textarea" })).toBe(true);
  expect(isTypingElement({ tagName: "SELECT" })).toBe(true);
  expect(isTypingElement({ tagName: "SPAN", isContentEditable: true })).toBe(true);
  expect(isTypingElement({ tagName: "SPAN", closest: (s) => (s.includes("input") ? {} : null) })).toBe(true);
  expect(isTypingElement({ tagName: "SPAN", closest: () => null })).toBe(false);
});
