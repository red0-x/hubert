// Security regression tests for the local-only HTTP guard and the argv builders that
// reach real CLIs. One file so the review's checks live together and stay cheap to run.
import { expect, test } from "bun:test";
import { guard } from "./server";
import { findPane } from "./voice/actions";
import { isSafeSessionId, sendArgv } from "./voice/send-adapters";

const PORT = Number(process.env.HUBERT_PORT ?? 7777);
const HOST = `127.0.0.1:${PORT}`;
const BASE = `http://${HOST}`;
const withOrigin = (origin?: string) =>
  new Request(`${BASE}/api/state`, { headers: origin === undefined ? { host: HOST } : { host: HOST, origin } });

test("guard rejects an opaque or malformed Origin instead of throwing a 500", () => {
  expect(guard(withOrigin())).toBeNull(); // a CLI/curl style request sends no Origin
  expect(guard(withOrigin(BASE))).toBeNull(); // the app's own origin
  // "null" (sandboxed iframe, data: or file: page) and junk previously threw out of the guard.
  for (const origin of ["null", "not a url", "http://evil.example", "http://127.0.0.1:1"])
    expect(guard(withOrigin(origin))?.status).toBe(403);
});

test("guard still refuses a foreign Host before it looks at Origin", () => {
  expect(guard(new Request(`${BASE}/api/state`, { headers: { host: "evil.example" } }))?.status).toBe(403);
});

test("findPane does not match every jcode pane when the name has no alphanumerics", () => {
  const panes = [{ session: "a", window: "0", title: "🌐 jcode Snail · +42 -0" }];
  expect(findPane(panes, "snail")?.session).toBe("a");
  expect(findPane(panes, "🚀")).toBeNull();
  expect(findPane(panes, "---")).toBeNull();
  expect(findPane(panes, "")).toBeNull();
});

test("a session id that would be read as a CLI flag is refused before any spawn", () => {
  expect(isSafeSessionId("abc-123")).toBe(true);
  expect(isSafeSessionId("")).toBe(false);
  expect(isSafeSessionId("   ")).toBe(false);
  expect(isSafeSessionId("--dangerously-skip-permissions")).toBe(false);
  expect(() => sendArgv("claude", "--dangerously-skip-permissions", "hi")).toThrow(/session id/);
  expect(() => sendArgv("codex", "-c", "hi")).toThrow(/session id/);
  expect(sendArgv("codex", "uuid", "hi")).toEqual(["codex", "exec", "resume", "uuid", "hi"]);
});
