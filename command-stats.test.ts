import { expect, test } from "bun:test";
import type { Command } from "./live";
import { commandStats, firstErrorLine, normalizeCommand, percentile, retryLoops } from "./command-stats";

test("normalizeCommand reduces known CLIs to command plus subcommand", () => {
  expect(normalizeCommand("git status --short")).toBe("git status");
  expect(normalizeCommand("git -C /repo commit -m 'fix bug'")).toBe("git commit");
  expect(normalizeCommand("bun test src/a.test.ts")).toBe("bun test");
  expect(normalizeCommand("cargo check --all-targets")).toBe("cargo check");
  expect(normalizeCommand("pytest tests/x_test.py -q")).toBe("pytest <path>");
  expect(normalizeCommand("go test ./...")).toBe("go test");
});

test("normalizeCommand handles package managers, paths, wrappers and edge cases", () => {
  expect(normalizeCommand("npm run build")).toBe("npm run build");
  expect(normalizeCommand("npm run lint -- --fix")).toBe("npm run lint");
  expect(normalizeCommand("npm install")).toBe("npm install");
  expect(normalizeCommand("rm -rf node_modules")).toBe("rm node_modules");
  expect(normalizeCommand("mkdir -p src/foo/bar")).toBe("mkdir <path>");
  expect(normalizeCommand("cd /repo && bun test")).toBe("bun test");
  expect(normalizeCommand("echo hello world")).toBe("echo hello world");
  expect(normalizeCommand("   \n  git status  \n")).toBe("git status");
  expect(normalizeCommand("")).toBe("");
});

test("percentile and firstErrorLine behave on small inputs", () => {
  expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
  expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
  expect(percentile([], 0.5)).toBe(0);
  expect(firstErrorLine("\n\nExit code: 7")).toBe("Exit code: 7");
  expect(firstErrorLine(undefined)).toBe("");
  expect(firstErrorLine("x".repeat(200)).length).toBe(120);
});

const cmd = (over: Partial<Command>): Command => ({ agent: "turtle", source: "jcode", tool: "bash", command: "echo", ok: true, ts: 1, ...over });

test("commandStats aggregates sent, failed, errors, durations and retry loops", () => {
  const commands: Command[] = [
    cmd({ command: "bun test", duration_ms: 100 }),
    cmd({ command: "bun test --watch", duration_ms: 200 }),
    cmd({ command: "bun test", ok: false, error: "AssertionError: nope\nstack", duration_ms: 900 }),
    cmd({ command: "bun test", ok: false, error: "AssertionError: nope\nstack", ts: 5 }),
    cmd({ command: "bun test", ok: false, error: "AssertionError: nope", ts: 9 }),
    cmd({ command: "git status", duration_ms: 50 }),
    cmd({ command: "git status", ok: false, error: "fatal: not a git repository" }),
    cmd({ agent: "snake", command: "bun test", ok: false, error: "boom" }),
  ];
  const stats = commandStats(commands);
  expect(stats.total).toBe(8);
  expect(stats.failed).toBe(5);
  expect(stats.mostSent[0]).toEqual({ command: "bun test", count: 6, failed: 4 });
  expect(stats.mostFailed[0]).toEqual({ command: "bun test", count: 6, failed: 4 });
  expect(stats.topErrors[0]).toEqual({ error: "AssertionError: nope", count: 3 });
  expect(stats.longest[0]).toMatchObject({ command: "bun test", normalized: "bun test", duration_ms: 900 });
  expect(stats.durations.find((d) => d.command === "bun test")).toEqual({ command: "bun test", count: 3, p50: 200, p95: 900, max: 900 });
  expect(stats.retryLoops).toEqual([{ agent: "turtle", command: "bun test", count: 3, lastTs: 9 }]);
});

test("retryLoops needs three failures by one agent and ignores other agents", () => {
  const commands: Command[] = [
    cmd({ command: "bun test", ok: false, ts: 1 }),
    cmd({ command: "bun test --watch", ok: false, ts: 2 }),
    cmd({ command: "bun test", ok: false, ts: 3 }),
    cmd({ agent: "snake", command: "bun test", ok: false, ts: 4 }),
    cmd({ agent: "snake", command: "bun test", ok: false, ts: 5 }),
  ];
  expect(retryLoops(commands)).toEqual([{ agent: "turtle", command: "bun test", count: 3, lastTs: 3 }]);
});
