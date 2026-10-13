import { afterEach, beforeEach, expect, test } from "bun:test";
import { createVoiceRecorder, micError, normalizeLevel } from "./recording";

test("normalizeLevel keeps silence at 0 and clamps loud input to 1", () => {
  expect(normalizeLevel(new Uint8Array(0))).toBe(0);
  expect(normalizeLevel(new Uint8Array([128, 128, 128, 128]))).toBe(0);
  expect(normalizeLevel(new Uint8Array([0, 255, 0, 255]))).toBe(1);
  const mid = normalizeLevel(new Uint8Array([160, 96, 160, 96]));
  expect(mid).toBeGreaterThan(0);
  expect(mid).toBeLessThan(1);
});

test("micError turns getUserMedia failures into actionable text", () => {
  expect(micError({ name: "NotAllowedError" })).toMatch(/Allow microphone/);
  expect(micError({ name: "NotFoundError" })).toMatch(/No microphone/);
  expect(micError({ name: "NotReadableError" })).toMatch(/busy in another app/);
  expect(micError(new Error("weird failure"))).toBe("weird failure");
  expect(micError(undefined)).toMatch(/Could not start/);
});

const originals = { navigator: globalThis.navigator, MediaRecorder: globalThis.MediaRecorder, fetch: globalThis.fetch, now: Date.now, AudioContext: (globalThis as { AudioContext?: unknown }).AudioContext, raf: globalThis.requestAnimationFrame, cancelRaf: globalThis.cancelAnimationFrame };
let stopped = 0;
let uploads = 0;
let clock = 1_000_000; // a controllable Date.now, so recording length is deterministic
const stream = () => ({ getTracks: () => [{ stop: () => stopped++ }] }) as unknown as MediaStream;
class Recorder {
  static instances: Recorder[] = [];
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: MediaStream) { Recorder.instances.push(this); }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(3000)]) });
      this.onstop?.();
    });
  }
}
beforeEach(() => {
  stopped = 0; uploads = 0; clock = 1_000_000; Recorder.instances = [];
  Date.now = () => clock;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream() } } });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder });
  globalThis.fetch = (async () => { uploads++; return Response.json({ text: "hello", connector: "local", ms: 42 }); }) as unknown as typeof fetch;
});
afterEach(() => {
  Date.now = originals.now;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originals.navigator });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: originals.MediaRecorder });
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: originals.AudioContext });
  globalThis.fetch = originals.fetch;
  globalThis.requestAnimationFrame = originals.raf;
  globalThis.cancelAnimationFrame = originals.cancelRaf;
});

test("release during microphone permission request cancels the recording and stops late tracks", async () => {
  let resolve!: (s: MediaStream) => void;
  navigator.mediaDevices.getUserMedia = () => new Promise(r => { resolve = r; });
  const states: string[] = [];
  const recorder = createVoiceRecorder(s => states.push(s), () => {}, () => {});
  const pending = recorder.start();
  void recorder.start();
  recorder.stop();
  resolve(stream());
  await pending;
  expect(Recorder.instances).toHaveLength(0);
  expect(stopped).toBe(1);
  expect(states.at(-1)).toBe("idle");
  expect(uploads).toBe(0);
});

test("a completed recording uploads once and always releases the microphone", async () => {
  const states: string[] = [];
  const transcripts: string[] = [];
  const recorder = createVoiceRecorder(s => states.push(s), text => transcripts.push(text), () => {});
  await recorder.start();
  await recorder.start();
  expect(Recorder.instances).toHaveLength(1);
  clock += 1000; // a real second of speech, over MIN_RECORDING_MS
  recorder.stop(); recorder.stop();
  await Bun.sleep(0);
  expect(stopped).toBe(1);
  expect(uploads).toBe(1);
  expect(transcripts).toEqual(["hello"]);
  expect(states.at(-1)).toBe("idle");
});

test("a clip under 300 ms is ignored with a message and nothing is uploaded", async () => {
  const errors: string[] = [];
  const recorder = createVoiceRecorder(() => {}, () => { throw new Error("unexpected transcript"); }, msg => errors.push(msg));
  await recorder.start();
  clock += 120;
  recorder.stop();
  await Bun.sleep(0);
  expect(uploads).toBe(0);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/too short/i);
});

test("metered silence is rejected before upload", async () => {
  let frames = 0;
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: class {
    createAnalyser() { return { fftSize: 256, getByteTimeDomainData: (s: Uint8Array) => s.fill(128), connect: () => {} }; }
    createMediaStreamSource() { return { connect: () => {} }; }
    close() { return Promise.resolve(); }
  } });
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { if (frames++ < 3) cb(0); return frames; }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  const errors: string[] = [];
  const recorder = createVoiceRecorder(() => {}, () => { throw new Error("unexpected transcript"); }, msg => errors.push(msg));
  await recorder.start();
  clock += 1000;
  recorder.stop();
  await Bun.sleep(0);
  expect(uploads).toBe(0);
  expect(errors[0]).toMatch(/silence/i);
});

test("no speech connector blocks start before the microphone is opened", async () => {
  const errors: string[] = [];
  const states: string[] = [];
  let opened = 0;
  navigator.mediaDevices.getUserMedia = async () => { opened++; return stream(); };
  const recorder = createVoiceRecorder(s => states.push(s), () => {}, msg => errors.push(msg), undefined, () => "No speech connector configured.");
  await recorder.start();
  expect(opened).toBe(0);
  expect(errors).toEqual(["No speech connector configured."]);
  expect(states).toEqual([]);
});

test("microphone permission failure surfaces an actionable message", async () => {
  navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }); };
  const errors: string[] = [];
  const recorder = createVoiceRecorder(() => {}, () => {}, msg => errors.push(msg));
  await recorder.start();
  expect(errors[0]).toMatch(/Allow microphone/);
});

test("cancel or dispose stops microphone without sending a transcript", async () => {
  for (const action of ["cancel", "dispose"] as const) {
    const recorder = createVoiceRecorder(() => {}, () => { throw new Error("unexpected transcript"); }, () => {});
    await recorder.start();
    recorder[action]();
    await Bun.sleep(0);
  }
  expect(stopped).toBe(2);
  expect(uploads).toBe(0);
});

test("recording initialization errors release tracks and return to idle", async () => {
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: class { constructor() { throw new Error("unsupported audio"); } } });
  const states: string[] = [];
  const errors: string[] = [];
  const recorder = createVoiceRecorder(s => states.push(s), () => {}, msg => errors.push(msg));
  await recorder.start();
  expect(stopped).toBe(1);
  expect(states.at(-1)).toBe("idle");
  expect(errors).toHaveLength(1);
});
