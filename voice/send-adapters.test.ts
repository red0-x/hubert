import { expect, test } from "bun:test";
import { canSend, dispatchSend, SEND_SOURCES, sendArgv } from "./send-adapters";

test("sendArgv: one argv element per argument, message never shell-split", () => {
  const nasty = 'review; rm -rf / && echo "hi" `whoami`';
  expect(sendArgv("claude", "abc-123", nasty)).toEqual(["claude", "-p", "--resume", "abc-123", nasty]);
  expect(sendArgv("codex", "uuid", nasty)).toEqual(["codex", "exec", "resume", "uuid", nasty]);
  expect(sendArgv("opencode", "ses_1", nasty)).toEqual(["opencode", "run", "--session", "ses_1", nasty]);
  expect(sendArgv("pi", "p1", nasty)).toEqual(["pi", "--print", "--session", "p1", nasty]);
  expect(sendArgv("omp", "o1", nasty)).toEqual(["omp", "--print", "--resume", "o1", nasty]);
  // the message stays exactly one element in every adapter
  for (const src of SEND_SOURCES) expect(sendArgv(src, "id", nasty).at(-1)).toBe(nasty);
});

test("sendArgv: refuses unsupported sources and bad input", () => {
  expect(() => sendArgv("cursor", "x", "hi")).toThrow(/no non-interactive send/);
  expect(() => sendArgv("jcode", "x", "hi")).toThrow(/no non-interactive send/);
  expect(() => sendArgv("claude", "", "hi")).toThrow(/session id/);
  expect(() => sendArgv("claude", "id", "   ")).toThrow(/empty message/);
  expect(canSend("codex")).toBe(true);
  expect(canSend("cursor")).toBe(false);
  expect(SEND_SOURCES.sort()).toEqual(["claude", "codex", "omp", "opencode", "pi"]);
});

test("dispatchSend: spawns the built argv in the agent's cwd, detached", () => {
  const calls: { argv: string[]; cwd?: string; unref: boolean }[] = [];
  const fake = (argv: string[], opts: { cwd?: string }) => ({
    unref: () => { calls.push({ argv, ...opts, unref: true }); },
  });
  const argv = dispatchSend({ source: "codex", id: "u1", cwd: "/repo" }, "hello", fake);
  expect(argv).toEqual(["codex", "exec", "resume", "u1", "hello"]);
  expect(calls).toEqual([{ argv, cwd: "/repo", unref: true }]);
  // a send that cannot be built must not spawn anything
  expect(() => dispatchSend({ source: "cursor", id: "c1", cwd: "" }, "hi", fake)).toThrow();
  expect(calls.length).toBe(1);
});
