import { test, expect, beforeEach } from "bun:test";
import { ANSWER_MS, bounds, clamp, hasMascotSprite, mascotState, resetMascotCache } from "./mascot";
import { mascotRoute } from "../server";

test("mascot coordinates stay in viewport, including tiny screens and malformed values", () => {
  expect(bounds({ x: 1, y: 1 }, 320, 200)).toEqual({ x: 264, y: 144 });
  expect(bounds({ x: -5, y: 9 }, 30, 40)).toEqual({ x: 0, y: 0 });
  expect(clamp(NaN)).toBe(0);
});

test("mascotState: error outranks every other signal", () => {
  expect(mascotState({ error: true, voice: "listening", thinking: true, now: 100 })).toBe("error");
  expect(mascotState({ stale: true, voice: "listening", now: 100 })).toBe("error");
});

test("mascotState: listening while recording, thinking while transcribing or pending", () => {
  expect(mascotState({ voice: "listening", now: 0 })).toBe("listening");
  expect(mascotState({ voice: "starting", now: 0 })).toBe("listening");
  expect(mascotState({ voice: "transcribing", now: 0 })).toBe("thinking");
  expect(mascotState({ voice: "transcribing", thinking: true, now: 0 })).toBe("thinking");
  expect(mascotState({ thinking: true, now: 0 })).toBe("thinking");
});

test("mascotState: speaking only inside the answer window", () => {
  expect(mascotState({ answeredAt: 1000, now: 1000 })).toBe("speaking");
  expect(mascotState({ answeredAt: 1000, now: 1000 + ANSWER_MS - 1 })).toBe("speaking");
  expect(mascotState({ answeredAt: 1000, now: 1000 + ANSWER_MS })).toBe("idle");
  expect(mascotState({ answeredAt: 1000, now: 999 })).toBe("idle");
  expect(mascotState({ now: 5000 })).toBe("idle");
});


const PORT = Number(process.env.HUBERT_PORT ?? 7777);
const HOST = `127.0.0.1:${PORT}`;
const head = (path: string) => new Request(`http://${HOST}${path}`, { method: "HEAD", headers: { host: HOST } });

beforeEach(() => resetMascotCache());

test("hasMascotSprite probes once and caches the answer per state", async () => {
  let calls = 0;
  const hit = (async () => { calls++; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
  expect(await hasMascotSprite("idle", hit)).toBe(true);
  expect(await hasMascotSprite("idle", hit)).toBe(true);
  expect(calls).toBe(1);
  const miss = (async () => { calls++; return new Response(null, { status: 404 }); }) as unknown as typeof fetch;
  expect(await hasMascotSprite("idle", miss)).toBe(true); // cached from the first probe
  expect(calls).toBe(1);
  const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect(await hasMascotSprite("error", boom)).toBe(false);
});

test("mascotRoute rejects traversal and non-image names, 404s missing sprites", () => {
  expect(mascotRoute(head("/mascot/../../etc/passwd")).status).toBe(400);
  expect(mascotRoute(head("/mascot/%2e%2e%2fsecret.png")).status).toBe(400);
  expect(mascotRoute(head("/mascot/idle.txt")).status).toBe(400);
  expect(mascotRoute(head("/mascot/none.png")).status).toBe(404);
  expect(mascotRoute(new Request(`http://evil.example/mascot/idle.png`, { headers: { host: "evil.example" } })).status).toBe(403);
});
