import { afterEach, beforeEach, expect, test } from "bun:test";
import { createVoiceRecorder } from "./recording";

const originals = { navigator: globalThis.navigator, MediaRecorder: globalThis.MediaRecorder, fetch: globalThis.fetch };
let stopped = 0;
let uploads = 0;
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
  stopped = 0; uploads = 0; Recorder.instances = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream() } } });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder });
  globalThis.fetch = (async () => { uploads++; return Response.json({ text: "hello", connector: "local" }); }) as unknown as typeof fetch;
});
afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originals.navigator });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: originals.MediaRecorder });
  globalThis.fetch = originals.fetch;
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
  recorder.stop(); recorder.stop();
  await Bun.sleep(0);
  expect(stopped).toBe(1);
  expect(uploads).toBe(1);
  expect(transcripts).toEqual(["hello"]);
  expect(states.at(-1)).toBe("idle");
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
