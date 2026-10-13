import { expect, test } from "bun:test";
import { byHeat, fileStats, hotspots } from "./change-stats";
import type { FileChange } from "../state";
import type { EditEvent } from "../live";

const file = (path: string, add = 0, del = 0): FileChange => ({ path, status: "M", add, del });
const edit = (path: string, agent: string, ts: number): EditEvent => ({ agent, root: "/repo", path, ts });

test("fileStats sums edits, agents, churn and ranks heat by recency and frequency", () => {
  const now = 1_000_000;
  const files = [file("hot.ts", 10, 2), file("cold.ts", 1, 0)];
  const events = [
    edit("hot.ts", "snail", now - 1000),
    edit("hot.ts", "snail", now - 2000),
    edit("hot.ts", "llama", now - 3000),
    edit("cold.ts", "snail", now - 20 * 60_000),
  ];
  const stats = fileStats(files, events, now);
  const hot = stats.find(s => s.path === "hot.ts")!;
  const cold = stats.find(s => s.path === "cold.ts")!;
  expect(hot.edits).toBe(3);
  expect(hot.agents.sort()).toEqual(["llama", "snail"]);
  expect(hot.churn).toBe(12);
  expect(hot.lastTs).toBe(now - 1000);
  expect(hot.heat).toBeGreaterThan(cold.heat);
  expect(hot.heat).toBeLessThanOrEqual(1);
  expect(cold.heat).toBeGreaterThanOrEqual(0);
});

test("fileStats tolerates files with no observed edits", () => {
  const s = fileStats([file("plain.ts", 2, 1)], [], 1000)[0]!;
  expect([s.edits, s.heat, s.lastTs, s.agents.length]).toEqual([0, 0, 0, 0]);
});

test("hotspots are files touched by more than one agent", () => {
  const now = 1000;
  const events = [edit("a.ts", "snail", now), edit("a.ts", "llama", now), edit("b.ts", "snail", now)];
  const stats = fileStats([file("a.ts"), file("b.ts")], events, now);
  expect(hotspots(stats).map(s => s.path)).toEqual(["a.ts"]);
});

test("byHeat orders hottest, then edits, then churn, then path", () => {
  const rows = [
    { path: "b", status: "M", edits: 1, agents: [], lastTs: 0, churn: 5, heat: 0.5 },
    { path: "a", status: "M", edits: 2, agents: [], lastTs: 0, churn: 9, heat: 0.5 },
    { path: "c", status: "M", edits: 0, agents: [], lastTs: 0, churn: 0, heat: 0.9 },
  ];
  expect([...rows].sort(byHeat).map(r => r.path)).toEqual(["c", "a", "b"]);
});
