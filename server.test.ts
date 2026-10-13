import { expect, test } from "bun:test";
import {
  defaultDeps, diffRoute, dispatch, executeRoute, guard, routes, transcribeRoute,
  type Deps,
} from "./server";

const PORT = Number(process.env.HUBERT_PORT ?? 7777);
const HOST = `127.0.0.1:${PORT}`;
const BASE = `http://${HOST}`;

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(BASE + path, { headers: { host: HOST, ...headers } });
const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  new Request(BASE + path, { method: "POST", headers: { host: HOST, "content-type": "application/json", ...headers }, body });

const makeDeps = (over: Partial<Deps>): Deps => ({ ...defaultDeps, ...over });

const collectStub = (() => ({
  now: 0,
  agents: [{ id: "a", name: "snail", source: "jcode", cwd: "/repo", repo: "/repo", state: "working", lastActive: 0 }],
  repos: [{ root: "/repo", name: "repo", branch: "main", files: [{ path: "a.ts", status: "M", add: 1, del: 0 }], agents: ["snail"] }],
})) as unknown as Deps["collect"];

test("guard rejects a foreign Host and a foreign Origin", () => {
  expect(guard(get("/api/state"))).toBeNull();
  expect(guard(new Request(BASE + "/api/state", { headers: { host: "evil.example" } }))?.status).toBe(403);
  expect(guard(new Request(BASE + "/api/state", { headers: { host: HOST, origin: "http://evil.example" } }))?.status).toBe(403);
  expect(guard(new Request(BASE + "/api/state", { headers: { host: HOST, origin: BASE } }))).toBeNull();
  expect(guard(new Request(BASE + "/api/state", { headers: { host: `localhost:${PORT}` } }))).toBeNull();
});

test("routes reject foreign Host/Origin before touching any data source", async () => {
  const boom: Deps = makeDeps({
    collect: (() => { throw new Error("collect must not run"); }) as unknown as Deps["collect"],
    fileDiff: () => { throw new Error("fileDiff must not run"); },
  });
  expect((await diffRoute(new Request(BASE + "/api/diff?root=/repo&file=a.ts", { headers: { host: "evil.example" } }), boom)).status).toBe(403);
  expect((await executeRoute(post("/api/execute", "{}", { host: "evil.example" }), boom)).status).toBe(403);
  expect((await transcribeRoute(new Request(BASE + "/api/transcribe", { method: "POST", headers: { host: HOST, origin: "http://evil.example", "content-type": "audio/wav" }, body: new Uint8Array([1]) }), boom)).status).toBe(403);
});

test("/api/diff returns 400 for a traversal or an unlisted file, 400 when fileDiff rejects, 200 otherwise", async () => {
  const deps = makeDeps({ collect: collectStub, fileDiff: () => "diff --git a/a.ts b/a.ts" });
  // Traversal is not a listed changed file, so it never reaches fileDiff.
  expect((await diffRoute(get("/api/diff?root=/repo&file=../../etc/passwd"), deps)).status).toBe(400);
  expect((await diffRoute(get("/api/diff?root=/elsewhere&file=a.ts"), deps)).status).toBe(400);
  const rejecting = makeDeps({ collect: collectStub, fileDiff: () => { throw new Error("invalid path"); } });
  expect((await diffRoute(get("/api/diff?root=/repo&file=a.ts"), rejecting)).status).toBe(400);
  const ok = await diffRoute(get("/api/diff?root=/repo&file=a.ts"), deps);
  expect(ok.status).toBe(200);
  expect(await ok.text()).toContain("diff --git");
});

test("/api/transcribe returns 415 for non-audio and 413 for empty or oversized audio", async () => {
  const deps = makeDeps({ transcribe: (async () => ({ text: "hi", ms: 7 })) as unknown as Deps["transcribe"] });
  const url = BASE + "/api/transcribe";
  expect((await transcribeRoute(new Request(url, { method: "POST", headers: { host: HOST, "content-type": "text/plain" }, body: "nope" }), deps)).status).toBe(415);
  expect((await transcribeRoute(new Request(url, { method: "POST", headers: { host: HOST, "content-type": "audio/wav" } }), deps)).status).toBe(413);
  const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
  expect((await transcribeRoute(new Request(url, { method: "POST", headers: { host: HOST, "content-type": "audio/wav" }, body: oversized }), deps)).status).toBe(413);
  const ok = await transcribeRoute(new Request(url, { method: "POST", headers: { host: HOST, "content-type": "audio/wav" }, body: new Uint8Array([1, 2, 3]) }), deps);
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { text: string; ms: number };
  expect(body.text).toBe("hi");
  expect(typeof body.ms).toBe("number");
});

test("/api/execute returns 409 for unconfirmed send/stop and 400 for unknown agents", async () => {
  const deps = makeDeps({
    collect: collectStub,
    execute: (async (a: { type: string }) => `ran ${a.type}`) as unknown as Deps["execute"],
    needsConfirm: new Set(["send", "stop"]),
  });
  const send = await executeRoute(post("/api/execute", JSON.stringify({ action: { type: "send", agent: "snail", text: "hi" } })), deps);
  expect(send.status).toBe(409);
  const stop = await executeRoute(post("/api/execute", JSON.stringify({ action: { type: "stop", agent: "snail" } })), deps);
  expect(stop.status).toBe(409);
  const unknown = await executeRoute(post("/api/execute", JSON.stringify({ action: { type: "send", agent: "ghost", text: "hi" }, confirmed: true })), deps);
  expect(unknown.status).toBe(400);
  const confirmed = await executeRoute(post("/api/execute", JSON.stringify({ action: { type: "send", agent: "snail", text: "hi" }, confirmed: true })), deps);
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toEqual({ result: "ran send" });
  const noAction = await executeRoute(post("/api/execute", "{}"), deps);
  expect(noAction.status).toBe(400);
});

test("dispatch answers 404 for unknown paths and 405 for an unsupported method", async () => {
  expect((await dispatch(routes, get("/nope"))).status).toBe(404);
  expect((await dispatch(routes, get("/api/nope"))).status).toBe(404);
  expect((await dispatch(routes, get("/api/execute"))).status).toBe(405);
});
