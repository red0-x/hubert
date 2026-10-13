import { afterEach, beforeEach, expect, test } from "bun:test";
import { createVoiceRecorder, micError, normalizeLevel, PREVIEW_TIMEOUT_MS } from "./recording";

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
  timeslice = 0;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: MediaStream) { Recorder.instances.push(this); }
  start(timeslice?: number) { this.state = "recording"; this.timeslice = timeslice ?? 0; }
  /** A growing snapshot mid-hold, exactly what MediaRecorder's timeslice emits. */
  emit(bytes = 3000) { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) }); }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(3000)]) });
      this.onstop?.();
    });
  }
}
const lastRecorder = () => Recorder.instances[Recorder.instances.length - 1]!;
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

test("holding shows a provisional preview but the final transcript is sent exactly once on release", async () => {
  let calls = 0;
  const sizes: number[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => { calls++; sizes.push((init?.body as Blob).size); return Response.json({ text: calls <= 2 ? "draft words" : "final words", connector: "local", ms: 1 }); }) as unknown as typeof fetch;
  const previews: string[] = []; const finals: string[] = [];
  const recorder = createVoiceRecorder(() => {}, t => finals.push(t), () => {}, undefined, undefined, t => previews.push(t), () => true);
  await recorder.start();
  const r = lastRecorder();
  expect(r.timeslice).toBeGreaterThan(0); // snapshots are requested from MediaRecorder at all
  r.emit(3000); await Bun.sleep(0); // under PREVIEW_MIN_MS: no preview yet
  clock += 1000; r.emit(3000); await Bun.sleep(0); // first preview
  clock += 1000; r.emit(3000); await Bun.sleep(0); // under PREVIEW_INTERVAL_MS: throttled
  clock += 1000; r.emit(3000); await Bun.sleep(0); // second preview
  expect(previews).toEqual(["draft words", "draft words"]);
  expect(finals).toEqual([]); // a preview never reaches the final transcript path
  clock += 1000; recorder.stop(); await Bun.sleep(0);
  expect(finals).toEqual(["final words"]);
  expect(calls).toBe(3); // two snapshots + one final upload
  expect(sizes[2]).toBeGreaterThan(sizes[1]!); // the final carries the whole clip, not a snapshot
});

test("release waits for an in-flight preview and drops its late result", async () => {
  let resolvePreview!: () => void;
  let calls = 0;
  globalThis.fetch = ((_url: string, _init?: RequestInit) => {
    calls++;
    if (calls === 1) return new Promise<Response>(res => { resolvePreview = () => res(Response.json({ text: "late preview", connector: "local" })); });
    return Promise.resolve(Response.json({ text: "final words", connector: "local", ms: 1 }));
  }) as unknown as typeof fetch;
  const previews: string[] = []; const finals: string[] = [];
  const recorder = createVoiceRecorder(() => {}, t => finals.push(t), () => {}, undefined, undefined, t => previews.push(t), () => true);
  await recorder.start();
  const r = lastRecorder();
  clock += 1000; r.emit(3000); await Bun.sleep(0);
  clock += 1000; r.emit(3000); await Bun.sleep(0); // a preview is in flight
  clock += 1000;
  recorder.stop();
  await Bun.sleep(0);
  expect(calls).toBe(1); // no final upload has started while the preview holds the socket
  resolvePreview();
  await Bun.sleep(0); await Bun.sleep(0);
  expect(calls).toBe(2); // exactly one final upload, after the preview settled
  expect(finals).toEqual(["final words"]);
  expect(previews).toEqual([]); // the preview resolved after release, so it never overwrote the final
});

test("cancel during a hold aborts the preview and sends no transcript", async () => {
  let aborted = false;
  globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; rej(Object.assign(new Error("aborted"), { name: "AbortError" })); });
  })) as unknown as typeof fetch;
  const previews: string[] = []; const finals: string[] = []; const states: string[] = [];
  const recorder = createVoiceRecorder(s => states.push(s), t => finals.push(t), () => {}, undefined, undefined, t => previews.push(t), () => true);
  await recorder.start();
  const r = lastRecorder();
  clock += 1000; r.emit(3000); await Bun.sleep(0);
  clock += 1000; r.emit(3000); await Bun.sleep(0);
  expect(previews).toEqual([]);
  recorder.cancel();
  await Bun.sleep(0); await Bun.sleep(0);
  expect(aborted).toBe(true);
  expect(finals).toEqual([]);
  expect(stopped).toBe(1);
  expect(states.at(-1)).toBe("idle");
});

test("no snapshot is uploaded when previews are not allowed (e.g. a cloud connector)", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ text: "final words", connector: "cloud", ms: 1 }); }) as unknown as typeof fetch;
  const previews: string[] = []; const finals: string[] = [];
  const recorder = createVoiceRecorder(() => {}, t => finals.push(t), () => {}, undefined, undefined, t => previews.push(t), () => false);
  await recorder.start();
  const r = lastRecorder();
  clock += 1000; r.emit(3000); await Bun.sleep(0);
  clock += 1000; r.emit(3000); await Bun.sleep(0);
  expect(calls).toBe(0); // the cloud connector is never charged for a snapshot
  clock += 1000; recorder.stop(); await Bun.sleep(0);
  expect(calls).toBe(1);
  expect(previews).toEqual([]);
  expect(finals).toEqual(["final words"]);
});

test("a hold shorter than MIN_RECORDING_MS is ignored even with previews enabled", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ text: "x", connector: "local" }); }) as unknown as typeof fetch;
  const errors: string[] = [];
  const recorder = createVoiceRecorder(() => {}, () => { throw new Error("unexpected transcript"); }, m => errors.push(m), undefined, undefined, () => {}, () => true);
  await recorder.start();
  lastRecorder().emit(3000); await Bun.sleep(0);
  clock += 120;
  recorder.stop(); await Bun.sleep(0);
  expect(calls).toBe(0);
  expect(errors[0]).toMatch(/too short/i);
});

test("a denied microphone surfaces the message and never starts a preview", async () => {
  navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); };
  const errors: string[] = []; let previews = 0;
  const recorder = createVoiceRecorder(() => {}, () => {}, m => errors.push(m), undefined, undefined, () => { previews++; }, () => true);
  await recorder.start();
  expect(errors[0]).toMatch(/Allow microphone/);
  expect(previews).toBe(0);
  expect(Recorder.instances).toHaveLength(0);
});

test("a stalled preview is aborted at PREVIEW_TIMEOUT_MS and cannot block the final upload", async () => {
  const realSetTimeout = globalThis.setTimeout;
  // Fire only the preview's own cap immediately; the recording length timer passes through.
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { if (ms === PREVIEW_TIMEOUT_MS) { fn(); return 0; } return realSetTimeout(fn, ms); }) as unknown as typeof setTimeout;
  try {
    let aborted = false; let calls = 0;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      calls++;
      if (calls === 1) return new Promise<Response>((_res, rej) => { init?.signal?.addEventListener("abort", () => { aborted = true; rej(Object.assign(new Error("timeout"), { name: "AbortError" })); }); });
      return Promise.resolve(Response.json({ text: "final words", connector: "local", ms: 1 }));
    }) as unknown as typeof fetch;
    const previews: string[] = []; const finals: string[] = [];
    const recorder = createVoiceRecorder(() => {}, t => finals.push(t), () => {}, undefined, undefined, t => previews.push(t), () => true);
    await recorder.start();
    const r = lastRecorder();
    clock += 1000; r.emit(3000); await Bun.sleep(0);
    clock += 1000; r.emit(3000); await Bun.sleep(0);
    expect(aborted).toBe(true); // the stalled snapshot hit its cap on its own
    clock += 1000; recorder.stop(); await Bun.sleep(0); await Bun.sleep(0);
    expect(calls).toBe(2); // the aborted preview + exactly one final upload
    expect(finals).toEqual(["final words"]);
    expect(previews).toEqual([]);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
