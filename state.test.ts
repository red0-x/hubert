import { expect, test } from "bun:test";
import { jsonLines, lastTool, parseChanges } from "./state";

test("parseChanges merges porcelain + numstat, handles renames and untracked", () => {
  const porcelain = "## main...origin/main\n M a.ts\nR  old.ts -> new.ts\n?? b.ts\n";
  const numstat = "3\t1\ta.ts\n0\t2\tnew.ts\n";
  expect(parseChanges(porcelain, numstat)).toEqual([
    { path: "a.ts", status: "M", add: 3, del: 1 },
    { path: "new.ts", status: "R", add: 0, del: 2 },
    { path: "b.ts", status: "??", add: 0, del: 0 },
  ]);
});

test("jsonLines skips a partial first line from a tail read", () => {
  expect(jsonLines('tial":1}\n{"a":1}\n\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
});

test("lastTool picks the newest tool_use and prefers intent", () => {
  const msgs = [
    [{ type: "tool_use", name: "read", input: { file_path: "x" } }],
    [{ type: "text", text: "hi" }, { type: "tool_use", name: "bash", input: { command: "ls", intent: "List" } }],
    [{ type: "tool_result" }],
  ];
  expect(lastTool(msgs)).toBe("bash: List");
  expect(lastTool([])).toBeUndefined();
});
