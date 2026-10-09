// Connector wire-format checks against a local mock. No network, no keys.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { CONNECTORS, activeConnector, sttStatus } from "./stt";

const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
const seen: { url: string; auth: string | null; ctype: string | null; model?: string | null; fileType?: string; bytes?: number }[] = [];
let server: ReturnType<typeof Bun.serve>;
const saved = { ...process.env };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const rec: (typeof seen)[number] = { url: url.pathname + url.search, auth: req.headers.get("authorization"), ctype: req.headers.get("content-type") };
      if (url.pathname === "/v1/audio/transcriptions") {
        const f = await req.formData();
        const file = f.get("file") as File;
        rec.model = f.get("model") as string;
        rec.fileType = file.type;
        rec.bytes = file.size;
        seen.push(rec);
        return Response.json({ text: " hello from openai-compatible " });
      }
      if (url.pathname === "/v1/listen") {
        rec.bytes = (await req.arrayBuffer()).byteLength;
        seen.push(rec);
        return Response.json({ results: { channels: [{ alternatives: [{ transcript: "hello from deepgram" }] }] } });
      }
      return new Response("boom", { status: 500 });
    },
  });
});
afterAll(() => {
  server.stop(true);
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const get = (id: string) => CONNECTORS.find((c) => c.id === id)!;

test("openai-compatible: multipart upload, bearer key, model, trims text", async () => {
  process.env.HUBERT_STT_URL = `http://127.0.0.1:${server.port}/v1/`;
  process.env.HUBERT_STT_KEY = "sk-test";
  process.env.HUBERT_STT_MODEL = "my-model";
  expect(get("openai-compatible").unavailable()).toBeNull();
  expect(await get("openai-compatible").transcribe(WAV)).toBe("hello from openai-compatible");
  const r = seen.at(-1)!;
  expect(r.url).toBe("/v1/audio/transcriptions");
  expect(r.auth).toBe("Bearer sk-test");
  expect(r.model).toBe("my-model");
  expect(r.fileType).toMatch(/^audio\/(x-)?wav$/);
  expect(r.bytes).toBe(WAV.length);
});

test("groq/openai need a key and use their own default models", () => {
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.HUBERT_STT_URL;
  expect(get("groq").unavailable()).toBe("missing API key");
  process.env.GROQ_API_KEY = "gsk";
  expect(get("groq").unavailable()).toBeNull();
});

test("groq sends to HUBERT_STT_URL override with its key", async () => {
  process.env.HUBERT_STT_URL = `http://127.0.0.1:${server.port}/v1`;
  process.env.HUBERT_STT_MODEL = "";
  process.env.GROQ_API_KEY = "gsk-test";
  await get("groq").transcribe(WAV);
  const r = seen.at(-1)!;
  expect(r.auth).toBe("Bearer gsk-test");
  expect(r.model).toBe("whisper-large-v3-turbo");
});

test("http errors surface as exceptions with the status", async () => {
  process.env.HUBERT_STT_URL = `http://127.0.0.1:${server.port}/nope`;
  await expect(get("groq").transcribe(WAV)).rejects.toThrow(/groq 500/);
});

test("deepgram: raw body, Token auth, parses transcript", async () => {
  process.env.DEEPGRAM_API_KEY = "dg-test";
  // point deepgram at the mock by patching fetch for its fixed host only
  const real = globalThis.fetch;
  globalThis.fetch = ((input: any, init: any) => real(String(input).replace("https://api.deepgram.com", `http://127.0.0.1:${server.port}`), init)) as typeof fetch;
  try {
    expect(await get("deepgram").transcribe(WAV)).toBe("hello from deepgram");
  } finally {
    globalThis.fetch = real;
  }
  const r = seen.at(-1)!;
  expect(r.auth).toBe("Token dg-test");
  expect(r.ctype).toBe("audio/wav");
  expect(r.bytes).toBe(WAV.length);
  expect(r.url).toContain("model=nova-3");
});

test("command: {wav} substituted, stdout returned, non-zero exit is an error", async () => {
  process.env.HUBERT_STT_COMMAND = "wc -c {wav}";
  const out = await get("command").transcribe(WAV);
  expect(out.startsWith(String(WAV.length))).toBe(true);
  process.env.HUBERT_STT_COMMAND = "false";
  await expect(get("command").transcribe(WAV)).rejects.toThrow(/exited 1/);
});

test("selection: HUBERT_STT wins, unknown id is null, no implicit API use", () => {
  process.env.HUBERT_STT = "deepgram";
  expect(activeConnector()?.id).toBe("deepgram");
  process.env.HUBERT_STT = "nonsense";
  expect(activeConnector()).toBeNull();
  delete process.env.HUBERT_STT;
  delete process.env.HUBERT_STT_SOCKET;
  process.env.HUBERT_DEFAULT_SOCKET = "/nonexistent/whisper.sock"; // keep the test independent of this machine
  process.env.HUBERT_STT_COMMAND = "";
  delete process.env.HUBERT_STT_URL;
  // keys are set (groq/deepgram) but they are api connectors, so nothing is chosen implicitly
  expect(activeConnector()).toBeNull();
  expect(sttStatus().active).toBeNull();
});
