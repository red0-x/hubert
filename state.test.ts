import { expect, test } from "bun:test";
import { jsonLines, lastTool, parseChanges, collect, repoInfo } from "./state";
import { clearMemoCache } from "./tail-cache";

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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

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

test("collect shares one in-flight scan and stays cached inside the ttl", async () => {
  clearMemoCache();
  const first = collect();
  expect(collect()).toBe(first); // same promise: no second directory scan or git round
  const state = await first;
  expect(Array.isArray(state.agents)).toBe(true);
  expect(Array.isArray(state.repos)).toBe(true);
  expect(collect()).toBe(first); // still fresh
});

test("repoInfo reads branch and changes through the async parallel git path", async () => {
  const root = mkdtempSync(join(tmpdir(), "hubert-repo-"));
  try {
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args], { stderr: "pipe" });
    git("init", "-b", "main");
    writeFileSync(join(root, "a.txt"), "one\n");
    git("add", "a.txt");
    const commit = git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@example.org", "commit", "-m", "init");
    expect(commit.exitCode, commit.stderr.toString()).toBe(0);
    writeFileSync(join(root, "a.txt"), "one\ntwo\n"); // +1 tracked line
    writeFileSync(join(root, "b.txt"), "new\n"); // untracked
    const info = await repoInfo(root);
    expect(info).toMatchObject({ name: basename(root), branch: "main" });
    expect(info.files.map((f) => [f.path, f.status, f.add, f.del])).toEqual([
      ["a.txt", "M", 1, 0],
      ["b.txt", "??", 0, 0],
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
