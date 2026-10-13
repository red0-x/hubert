import { expect, test } from "bun:test";
import { speak, speechSupported } from "./speech";

const fake = () => {
  const spoken: string[] = [];
  let cancelled = 0;
  const g = {
    speechSynthesis: { speak: (u: unknown) => spoken.push((u as { text: string }).text), cancel: () => { cancelled++; } },
    SpeechSynthesisUtterance: class { constructor(public text: string) {} },
  };
  return { g, spoken, cancelled: () => cancelled };
};

test("speechSupported is false when speechSynthesis or the utterance constructor is missing", () => {
  expect(speechSupported(undefined)).toBe(false);
  expect(speechSupported({})).toBe(false);
  expect(speechSupported({ speechSynthesis: { speak: () => {} } })).toBe(false);
  expect(speechSupported(fake().g)).toBe(true);
});

test("speak trims text, cancels a previous reply, and ignores empty or unsupported input", () => {
  const { g, spoken, cancelled } = fake();
  speak("  hello world  ", g);
  expect(spoken).toEqual(["hello world"]);
  expect(cancelled()).toBe(1);
  speak("   ", g);
  expect(spoken).toEqual(["hello world"]);
  expect(() => speak("hi", undefined)).not.toThrow();
  expect(() => speak("hi", {})).not.toThrow();
});
