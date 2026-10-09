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

import { codexDoing, piDoing, resolveSlug } from "./state";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test("codexDoing reads function_call JSON args and custom_tool_call JS", () => {
  expect(codexDoing([{ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls -la"}' } }])).toBe("exec_command: ls -la");
  expect(codexDoing([{ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: 'const r = await tools.exec_command({"cmd":"sed -n 1,5p x","yield_time_ms":1})' } }])).toBe("exec: sed -n 1,5p x");
  expect(codexDoing([{ type: "event_msg", payload: {} }])).toBeUndefined();
});
test("piDoing reads toolCall blocks (omp and pi)", () => {
  expect(piDoing([{ message: { content: [{ type: "text" }, { type: "toolCall", name: "bash", arguments: { command: "bun test" } }] } }])).toBe("bash: bun test");
});
test("resolveSlug disambiguates dashes and dots against real directories", () => {
  const base = mkdtempSync(join(tmpdir(), "slug-"));
  mkdirSync(join(base, "my-app", ".config"), { recursive: true });
  expect(resolveSlug("my-app-config", base)).toBe(join(base, "my-app", ".config"));
  expect(resolveSlug("nope", base)).toBeNull();
});
