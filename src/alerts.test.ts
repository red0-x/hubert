import { expect, test } from "bun:test";
import type { Command } from "../live";
import type { Agent, Repo } from "../state";
import { DEFAULT_THRESHOLDS, detectAlerts, freshAlerts, nextWorkingSince, type Observed } from "./alerts";

const agent = (over: Partial<Agent>): Agent => ({ id: "a1", name: "turtle", source: "jcode", cwd: "/repo", repo: null, state: "working", lastActive: 0, ...over });
const repo = (over: Partial<Repo>): Repo => ({ root: "/repo", name: "repo", branch: "main", files: [], agents: [], ...over });
const cmd = (over: Partial<Command>): Command => ({ agent: "turtle", source: "jcode", tool: "bash", command: "bun test", ok: false, ts: 1, ...over });
const observed = (now: number, agents: Agent[], repos: Repo[], workingSince: Record<string, number> = {}): Observed => ({ now, agents, repos, workingSince });

test("agent finishing after long work fires once, short or unrelated transitions do not", () => {
  const start = 1_000_000;
  const prev = observed(start, [agent({ state: "working" })], [], { a1: start });
  const longAfter = start + 10 * 60_000;
  const done = observed(longAfter, [agent({ state: "idle", lastActive: longAfter })], [], {});
  const alerts = detectAlerts(prev, done, []);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ kind: "finished", severity: "info", agent: "turtle" });
  expect(alerts[0]!.detail).toContain("10m");

  const quick = detectAlerts(prev, observed(start + 60_000, [agent({ state: "idle" })], [], {}), []);
  expect(quick).toEqual([]);
  // Never seen working: no finish alert.
  expect(detectAlerts(null, done, [])).toEqual([]);
});

test("retry loops surface as warnings via command-stats detection", () => {
  const commands = [cmd({ ts: 1 }), cmd({ ts: 2 }), cmd({ ts: 3 })];
  const alerts = detectAlerts(null, observed(100, [], []), commands);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ kind: "retry-loop", severity: "warn", agent: "turtle" });
  expect(alerts[0]!.id).toBe("retry:turtle:bun test");
});

test("idle agent with uncommitted changes warns, clean or recent idle does not", () => {
  const now = 2_000_000;
  const dirty = observed(now, [agent({ state: "idle", repo: "/repo", lastActive: now - 20 * 60_000 })], [repo({ files: [{ path: "x.ts", status: "M", add: 1, del: 2 }] })]);
  const alerts = detectAlerts(null, dirty, []);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ kind: "idle-dirty", repo: "repo" });

  const clean = observed(now, [agent({ state: "idle", repo: "/repo", lastActive: now - 20 * 60_000 })], [repo({ files: [] })]);
  expect(detectAlerts(null, clean, [])).toEqual([]);
  const recent = observed(now, [agent({ state: "idle", repo: "/repo", lastActive: now - 60_000 })], [repo({ files: [{ path: "x", status: "M", add: 1, del: 1 }] })]);
  expect(detectAlerts(null, recent, [])).toEqual([]);
});

test("a large diff growing fast alerts, slow growth or small diffs do not", () => {
  const t0 = 5_000_000;
  const before = observed(t0, [], [repo({ files: [{ path: "a", status: "M", add: 50, del: 50 }] })]);
  const fast = observed(t0 + 60_000, [], [repo({ files: [{ path: "a", status: "M", add: 300, del: 300 }] })]);
  const alerts = detectAlerts(before, fast, []);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ kind: "diff-growing", repo: "repo" });

  const slow = observed(t0 + 60_000, [], [repo({ files: [{ path: "a", status: "M", add: 100, del: 100 }] })]);
  expect(detectAlerts(before, slow, [])).toEqual([]);
  const small = observed(t0 + 60_000, [], [repo({ files: [{ path: "a", status: "M", add: 90, del: 90 }] })]);
  expect(detectAlerts(before, small, [])).toEqual([]);
});

test("freshAlerts dedupes while a condition persists and re-fires after it clears", () => {
  const a = detectAlerts(null, observed(10, [], []), [cmd({ ts: 1 }), cmd({ ts: 2 }), cmd({ ts: 3 })]);
  expect(a).toHaveLength(1);
  const first = freshAlerts(new Set(), a);
  expect(first.fresh).toHaveLength(1);

  const again = freshAlerts(first.suppressed, a);
  expect(again.fresh).toEqual([]);

  const cleared = freshAlerts(again.suppressed, []);
  expect(cleared.suppressed.size).toBe(0);
  const recurs = freshAlerts(cleared.suppressed, a);
  expect(recurs.fresh).toHaveLength(1);
});

test("nextWorkingSince starts episodes and only keeps currently working agents", () => {
  const now = 100;
  const first = nextWorkingSince(null, [agent({ id: "x", state: "working" }), agent({ id: "y", state: "idle" })], now);
  expect(first).toEqual({ x: now });
  const carried = nextWorkingSince({ now: 50, agents: [], repos: [], workingSince: { x: 10, y: 5 } }, [agent({ id: "x", state: "working" }), agent({ id: "y", state: "idle" })], now);
  expect(carried).toEqual({ x: 10 });
});

test("defaults are the documented thresholds", () => {
  expect(DEFAULT_THRESHOLDS).toEqual({ longWorkMs: 300_000, idleDirtyMs: 600_000, retryCount: 3, diffMinLines: 200, diffRatePerMin: 120 });
});
