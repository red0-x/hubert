import { expect, test } from "bun:test";
import type { Repo } from "../state";
import type { EditEvent } from "../live";
import { mergeFeed, repoSummaries, type FeedItem } from "./dashboard";
import { diffInfo } from "./live-view";

test("mergeFeed orders newest first, caps the list and leaves the input alone", () => {
  const items: FeedItem[] = [
    { ts: 100, agent: "a", kind: "edit", text: "x" },
    { ts: 300, agent: "b", kind: "command", text: "y", ok: false },
    { ts: 200, agent: "c", kind: "state", text: "is now idle" },
  ];
  expect(mergeFeed(items).map((i) => i.ts)).toEqual([300, 200, 100]);
  expect(mergeFeed(items, 2).map((i) => i.ts)).toEqual([300, 200]);
  expect(items.map((i) => i.ts)).toEqual([100, 300, 200]);
});

test("repoSummaries ranks hot files per repo, ignores other repos and counts shared files", () => {
  const repo = (root: string, files: Repo["files"]): Repo => ({ root, name: root.split("/").pop()!, branch: "main", files, agents: ["a"] });
  const file = (path: string) => ({ path, status: "M", add: 1, del: 0 });
  const repos = [repo("/r/one", [file("a.ts"), file("b.ts"), file("c.ts")]), repo("/r/two", [file("d.ts")])];
  const now = 10_000;
  const edits: EditEvent[] = [
    { agent: "a", root: "/r/one", path: "a.ts", ts: now - 1000 },
    { agent: "a", root: "/r/one", path: "a.ts", ts: now - 500 },
    { agent: "b", root: "/r/one", path: "c.ts", ts: now - 9000 },
    { agent: "a", root: "/r/one", path: "c.ts", ts: now - 9500 },
    { agent: "x", root: "/r/two", path: "d.ts", ts: 0 },
  ];
  const [one, two] = repoSummaries(repos, edits, now, 2);
  expect(one!.files.map((f) => f.path)).toEqual(["a.ts", "c.ts"]);
  expect(one!.files[0]!.edits).toBe(2);
  expect(one!.shared).toBe(1); // c.ts was touched by two agents
  expect(two!.files.map((f) => f.path)).toEqual(["d.ts"]);
});

test("diffInfo reports churn, hunks and the newest agent that touched the file", () => {
  const raw = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,3 @@", " keep", "-old", "+new", "+extra"].join("\n");
  const info = diffInfo("x.ts", raw, [
    { agent: "old", root: "/r", path: "x.ts", ts: 10 },
    { agent: "new", root: "/r", path: "x.ts", ts: 99 },
    { agent: "other", root: "/r", path: "y.ts", ts: 200 },
  ], "/r");
  expect(info).toMatchObject({ path: "x.ts", add: 2, del: 1, hunks: 1, lastTs: 99, agent: "new" });
});

test("diffInfo falls back to no touching agent when nothing matches", () => {
  const info = diffInfo("x.ts", "old\n", [{ agent: "a", root: "/r", path: "y.ts", ts: 5 }], "/r");
  expect([info.agent, info.lastTs, info.hunks]).toEqual([undefined, 0, 0]);
});
