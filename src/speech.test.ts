import { beforeEach, expect, test } from "bun:test";
import {
  ACK_MAX_WORDS,
  ANSWER_MAX_CHARS,
  DUPLICATE_WINDOW_MS,
  listVoices,
  setSpeechListening,
  speak,
  speakableText,
  speechDiagnostic,
  speechSupported,
  stopSpeech,
  type SpeechGlobal,
  type SpeechUtterance,
  type SpeechVoice,
} from "./speech";

const VOICES: SpeechVoice[] = [
  { name: "Amy", lang: "en-US", voiceURI: "amy" },
  { name: "Daniel", lang: "en-GB", voiceURI: "daniel", default: true },
];

const fake = (voices: SpeechVoice[] = VOICES) => {
  const spoken: SpeechUtterance[] = [];
  let cancelled = 0;
  const g: SpeechGlobal = {
    speechSynthesis: {
      speak: (u) => spoken.push(u as SpeechUtterance),
      cancel: () => { cancelled++; },
      getVoices: () => voices,
    },
    SpeechSynthesisUtterance: class { constructor(public text: string) {} },
  };
  return { g, spoken, cancelled: () => cancelled };
};

beforeEach(() => setSpeechListening(false));

test("support detection and the unsupported-build diagnostic", () => {
  expect(speechSupported(undefined)).toBe(false);
  expect(speechSupported({})).toBe(false);
  expect(speechSupported({ speechSynthesis: { speak: () => {} } })).toBe(false);
  expect(speechSupported(fake().g)).toBe(true);

  expect(speechDiagnostic({})).toContain("SpeechSynthesisUtterance");
  expect(speechDiagnostic({ SpeechSynthesisUtterance: class { constructor(public text: string) {} } })).toContain("WebKit");
  expect(speechDiagnostic(fake().g)).toBeNull();
});

test("listVoices reports only real installed voices, with no name-based guessing", () => {
  const { g } = fake([...VOICES, { name: "", lang: "" }, { name: "Broken", lang: undefined as unknown as string }]);
  expect(listVoices(g).map((v) => v.name)).toEqual(["Amy", "Daniel"]);
  expect(listVoices({})).toEqual([]);
});

test("speakableText clips acks to a short phrase and refuses large answers", () => {
  expect(speakableText("   ", "answer")).toBeNull();
  expect(speakableText("Focused snail", "ack")).toBe("Focused snail");
  const words = Array.from({ length: ACK_MAX_WORDS + 4 }, (_, i) => `w${i}`);
  const ack = speakableText(words.join(" "), "ack")!;
  expect(ack.split(" ")).toHaveLength(ACK_MAX_WORDS); // clipped to the cap
  expect(ack.endsWith("…")).toBe(true);

  expect(speakableText("Snail is editing the nav bar.", "answer")).toBe("Snail is editing the nav bar.");
  expect(speakableText("x".repeat(ANSWER_MAX_CHARS + 1), "answer")).toBeNull();
  expect(speakableText(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"), "answer")).toBeNull();
  expect(speakableText("line one\nline two", "answer")).toBe("line one line two");
});

test("speak applies voice selection, bounded pitch/rate, cancels a previous reply", () => {
  const { g, spoken, cancelled } = fake();
  speak("hello world", g, { voice: "daniel", pitch: 1.4, rate: 1.1 });
  expect(spoken).toHaveLength(1);
  expect(spoken[0]!.text).toBe("hello world");
  expect(spoken[0]!.pitch).toBe(1.4);
  expect(spoken[0]!.rate).toBe(1.1);
  expect((spoken[0]!.voice as SpeechVoice).name).toBe("Daniel");
  expect(cancelled()).toBe(1);

  // Out-of-range knobs are clamped at the boundary, not trusted.
  speak("again", g, { pitch: 99, rate: -5, now: Date.now() + 1 });
  expect(spoken[1]!.pitch).toBe(2);
  expect(spoken[1]!.rate).toBe(0.5);
  // Unknown voice falls back to the engine default (no voice set).
  expect(spoken[1]!.voice).toBeUndefined();

  // Empty and unsupported input is a no-op.
  speak("   ", g, { now: Date.now() + 2 });
  expect(spoken).toHaveLength(2);
  expect(() => speak("hi", undefined)).not.toThrow();
  expect(() => speak("hi", {})).not.toThrow();
});

test("duplicate replies inside the window are dropped, later ones are not", () => {
  const { g, spoken } = fake();
  speak("Focused snail", g, { kind: "ack", now: 1000 });
  speak("Focused snail", g, { kind: "ack", now: 1000 + DUPLICATE_WINDOW_MS - 1 });
  expect(spoken).toHaveLength(1);
  speak("Focused snail", g, { kind: "ack", now: 1000 + DUPLICATE_WINDOW_MS });
  expect(spoken).toHaveLength(2);
  speak("Something else", g, { kind: "ack", now: 1000 + DUPLICATE_WINDOW_MS + 1 });
  expect(spoken).toHaveLength(3);
});

test("speech stays silent while the mic is open and cancels what is playing", () => {
  const { g, spoken, cancelled } = fake();
  speak("first", g);
  expect(spoken).toHaveLength(1);
  setSpeechListening(true, g);
  expect(cancelled()).toBeGreaterThanOrEqual(1);
  speak("while listening", g, { now: Date.now() + 1 });
  expect(spoken).toHaveLength(1);
  setSpeechListening(false, g);
  speak("after", g, { now: Date.now() + 2 });
  expect(spoken).toHaveLength(2);
});

test("stopSpeech cancels without speaking and is safe when unsupported", () => {
  const { g, spoken, cancelled } = fake();
  stopSpeech(g);
  stopSpeech(undefined);
  expect(cancelled()).toBe(1);
  expect(spoken).toHaveLength(0);
});
