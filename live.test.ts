import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { recentCommands, fileDiff, editEvents, codexCommands } from "./live";

const git = (root: string, ...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args], { stderr: "pipe" });

test("recentCommands joins only completed bash calls across recent sessions", () => {
  const base = mkdtempSync(join(tmpdir(), "hubert-live-"));
  try {
    const j = join(base, "jcode"), c = join(base, "claude");
    mkdirSync(j); mkdirSync(join(c, "project"), { recursive: true });
    const lines = [
      { append_messages: [{ role: "assistant", content: [{ type: "tool_use", id: "one", name: "bash", input: { command: "echo one", intent: "say one" } }, { type: "tool_use", id: "pending", name: "bash", input: { command: "not done" } }] }] },
      { append_messages: [{ role: "user", tool_duration_ms: 23, content: [{ type: "tool_result", tool_use_id: "one", content: "ok" }] }] },
      { append_messages: [{ role: "assistant", content: [{ type: "tool_use", id: "failed", name: "bash", input: { command: "exit 7" } }] }] },
      { append_messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "failed", content: "\n\nExit code: 7" }] }] },
      { append_messages: [{ role: "assistant", content: [{ type: "tool_use", id: "old", name: "bash", input: { command: "exit 8" } }, { type: "tool_use", id: "literal", name: "bash", input: { command: "echo Exit code: 7" } }] }] },
      { append_messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: "Command finished with exit code: 8" }, { type: "tool_result", tool_use_id: "literal", content: "Exit code: 7\n" }] }] },
    ];
    writeFileSync(join(j, "session.journal.jsonl"), lines.map(x => JSON.stringify(x)).join("\n") + "\n");
    writeFileSync(join(j, "session.json"), JSON.stringify({ short_name: "turtle" }));
    writeFileSync(join(c, "project", "session.jsonl"), [
      { type: "assistant", timestamp: "2026-10-08T05:00:00Z", message: { content: [{ type: "tool_use", id: "two", name: "Bash", input: { command: "false", description: "fail" } }] } },
      { type: "user", timestamp: "2026-10-08T05:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "two", is_error: true, content: "failed" }] } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    const commands = recentCommands(j, c);
    expect(commands.map(x => x.command).sort()).toEqual(["echo Exit code: 7", "echo one", "exit 7", "exit 8", "false"]);
    expect(commands.find(x => x.command === "echo one")).toMatchObject({ agent: "turtle", source: "jcode", ok: true, duration_ms: 23, intent: "say one" });
    expect(commands.find(x => x.command === "false")).toMatchObject({ source: "claude", ok: false, error: "failed", duration_ms: 1000 });
    expect(commands.find(x => x.command === "exit 7")).toMatchObject({ source: "jcode", ok: false, error: "\n\nExit code: 7" });
    expect(commands.find(x => x.command === "exit 8")?.ok).toBe(false);
    expect(commands.find(x => x.command === "echo Exit code: 7")?.ok).toBe(true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("fileDiff returns tracked diff and untracked content but rejects unrelated paths", () => {
  const root = mkdtempSync(join(tmpdir(), "hubert-git-"));
  try {
    expect(git(root, "init").exitCode).toBe(0);
    writeFileSync(join(root, "tracked.txt"), "before\n");
    git(root, "add", "tracked.txt");
    const commit = git(root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-m", "initial");
    expect(commit.exitCode, commit.stderr.toString()).toBe(0);
    writeFileSync(join(root, "tracked.txt"), "after\n");
    writeFileSync(join(root, "new.txt"), "new contents\n");
    writeFileSync(join(root, "unchanged.txt"), "not staged\n");
    expect(fileDiff(root, "tracked.txt")).toContain("+after");
    expect(fileDiff(root, "new.txt")).toBe("new contents\n");
    expect(() => fileDiff(root, "unchanged.txt/../tracked.txt")).toThrow();
    expect(() => fileDiff(root, "../secret")).toThrow();
    expect(() => fileDiff(root, ".git/config")).toThrow();
    expect(() => fileDiff(root, "missing.txt")).toThrow();
    expect(() => fileDiff(root, "new.txt\0evil")).toThrow();
    const outside = mkdtempSync(join(tmpdir(), "hubert-outside-"));
    try {
      writeFileSync(join(outside, "secret"), "secret");
      symlinkSync(join(outside, "secret"), join(root, "link"));
      expect(() => fileDiff(root, "link")).toThrow();
    } finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("edit events count observed tool calls and skip malformed lines", () => {
  const base = mkdtempSync(join(tmpdir(), "hubert-edits-"));
  try {
    const root = join(base, "repo"), sessions = join(base, "sessions"), claude = join(base, "claude");
    mkdirSync(root); mkdirSync(sessions); mkdirSync(claude);
    writeFileSync(join(sessions, "one.json"), JSON.stringify({ working_dir: root }));
    writeFileSync(join(sessions, "one.journal.jsonl"), ["broken", ...[1,2].map(() => JSON.stringify({ append_messages: [{ content: [{ type: "tool_use", name: "edit", input: { file_path: "a.ts" } }] }] }))].join("\n"));
    expect(editEvents([{ root }], sessions, claude, join(root, "no-codex")).map(e => e.path)).toEqual(["a.ts", "a.ts"]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

import { codexEdits } from "./live";
import { mkdirSync as mk, mkdtempSync as tmp, writeFileSync as wf } from "fs";
import { tmpdir as td } from "os";
import { join as j } from "path";
test("codexEdits reports successful patch_apply_end inside a repo, ignores failures and outside paths", () => {
  const dir = tmp(j(td(), "cx-"));
  const day = j(dir, "2026", "10", "09"); mk(day, { recursive: true });
  const row = (success: boolean, file: string) => JSON.stringify({ timestamp: "2026-10-09T10:00:00Z", type: "event_msg", payload: { type: "patch_apply_end", success, changes: { [file]: { type: "update" } } } });
  wf(j(day, "rollout-x-0123456789abcdef0123456789abcdef0123.jsonl"), [
    JSON.stringify({ type: "turn_context", payload: { cwd: "/repo" } }),
    row(true, "/repo/src/a.ts"), row(false, "/repo/src/b.ts"), row(true, "/elsewhere/c.ts"),
  ].join("\n"));
  const events = codexEdits([{ root: "/repo" }], dir);
  expect(events.map((e) => e.path)).toEqual(["src/a.ts"]);
  expect(events[0]!.agent.startsWith("cx-repo-")).toBe(true);
});

// Shapes below are copied from a real ~/.codex/sessions rollout (codex-cli 0.145.0):
// exec is recorded as a JS cell, and its output is prefixed with a Script/Wall time header.
test("codexCommands pairs exec cells with output, reads duration, and only fails on Script error", () => {
  const dir = tmp(j(td(), "cx-cmd-"));
  const day = j(dir, "2026", "07", "28"); mk(day, { recursive: true });
  const exec = (callId: string, input: string, ts: string) => JSON.stringify({
    timestamp: ts, type: "response_item",
    payload: { type: "custom_tool_call", id: `ctc_${callId}`, status: "completed", call_id: callId, name: "exec", input },
  });
  const cell = (cmd: string) => `const r = await tools.exec_command(${JSON.stringify({ cmd, yield_time_ms: 10000, max_output_tokens: 20000 })});\ntext(r.output);\n`;
  const out = (callId: string, header: string, body: string, ts: string) => JSON.stringify({
    timestamp: ts, type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text: header }, { type: "input_text", text: body }] },
  });
  const header = (kind: string, seconds: string) => `Script ${kind}\nWall time ${seconds} seconds\nOutput:\n`;
  wf(j(day, "rollout-2026-07-28T12-57-47-0123456789abcdef0123456789abcdef0123.jsonl"), [
    JSON.stringify({ timestamp: "2026-07-28T19:57:00Z", type: "turn_context", payload: { cwd: "/repo", model: "gpt-5.6-terra" } }),
    exec("call_1", cell("sed -n '1,240p' /repo/a.ts"), "2026-07-28T19:58:12Z"),
    exec("call_patch", "const patch = \"*** Begin Patch\\n*** Update File: /repo/a.ts\\n*** End Patch\";\nconst r = await tools.apply_patch(patch);", "2026-07-28T19:58:20Z"),
    out("call_1", header("completed", "10.2"), "---\nname: ponytail\n", "2026-07-28T19:58:22Z"),
    exec("call_2", cell("false"), "2026-07-28T19:59:00Z"),
    out("call_2", header("error:", "0.5"), "ReferenceError: boom\n", "2026-07-28T19:59:01Z"),
    JSON.stringify({ timestamp: "2026-07-28T19:59:30Z", type: "response_item", payload: { type: "function_call", call_id: "call_wait", name: "wait", arguments: "{\"cell_id\":\"5\",\"yield_time_ms\":10000}" } }),
    JSON.stringify({ timestamp: "2026-07-28T19:59:31Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_wait", output: [{ type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" }, { type: "input_text", text: "{}" }] } }),
  ].join("\n"));
  const commands = codexCommands(dir);
  expect(commands.map((c) => c.command)).toEqual(["sed -n '1,240p' /repo/a.ts", "false"]);
  expect(commands[0]).toMatchObject({ source: "codex", tool: "exec", duration_ms: 10200 });
  expect(commands[0]!.ok).toBeUndefined(); // Script completed proves the cell finished, not exit 0.
  expect(commands[0]!.agent.startsWith("cx-repo-")).toBe(true);
  expect(commands[1]).toMatchObject({ ok: false, duration_ms: 500, error: "ReferenceError: boom\n" });
  const empty = tmp(j(td(), "empty-")); mk(empty, { recursive: true });
  const merged = recentCommands(j(empty, "jcode"), j(empty, "claude"), dir);
  expect(merged.map((c) => c.command)).toEqual(["false", "sed -n '1,240p' /repo/a.ts"]);
});

// Shapes below are copied from real ~/.claude/projects transcripts (claude 2.1.x): a Bash tool_use in an
// assistant record, its tool_result in a later user record carrying is_error and its own timestamp.
test("recentCommands reads Claude is_error and timestamp-gap duration, one stable agent per session, and skips sidechain files", () => {
  const base = tmp(j(td(), "hubert-cc-cmd-"));
  try {
    const c = j(base, "claude"), none = j(base, "none");
    const proj = j(c, "-home-red-Documents-GitHub-widget"); mk(proj, { recursive: true });
    const sid = "dd1111-2222-4333-8444-555566667777";
    writeFileSync(j(proj, `${sid}.jsonl`), [
      JSON.stringify({ isSidechain: false, type: "assistant", timestamp: "2026-10-08T05:00:00.000Z", cwd: "/repo/sub", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "true", description: "ok" } }] } }),
      JSON.stringify({ isSidechain: false, type: "user", timestamp: "2026-10-08T05:00:01.500Z", cwd: "/repo", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: false, content: "done" }] } }),
      JSON.stringify({ isSidechain: false, type: "assistant", timestamp: "2026-10-08T05:00:02.000Z", cwd: "/repo", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "false" } }] } }),
      JSON.stringify({ isSidechain: false, type: "user", timestamp: "2026-10-08T05:00:02.750Z", cwd: "/repo", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b", is_error: true, content: "Exit code 1\nboom" }] } }),
    ].join("\n") + "\n");
    writeFileSync(j(proj, "agent-eeee.jsonl"), [
      JSON.stringify({ isSidechain: true, type: "assistant", timestamp: "2026-10-08T05:00:03.000Z", cwd: "/repo", message: { role: "assistant", model: "claude-haiku-4-5", content: [{ type: "tool_use", id: "z", name: "Bash", input: { command: "sidechain-only" } }] } }),
      JSON.stringify({ isSidechain: true, type: "user", timestamp: "2026-10-08T05:00:03.500Z", cwd: "/repo", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "z", is_error: false, content: "ok" }] } }),
    ].join("\n") + "\n");
    const cmds = recentCommands(j(none, "jcode"), c, j(none, "codex"));
    expect(cmds.map((x) => x.command).sort()).toEqual(["false", "true"]);
    // The newest cwd wins, so both commands carry the same agent even though the first ran from /repo/sub.
    expect(cmds.find((x) => x.command === "true")).toMatchObject({ source: "claude", ok: true, duration_ms: 1500, agent: `cc-repo-${sid.slice(0, 4)}`, intent: "ok" });
    expect(cmds.find((x) => x.command === "false")).toMatchObject({ ok: false, duration_ms: 750, error: "Exit code 1\nboom", agent: `cc-repo-${sid.slice(0, 4)}` });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("edit events map Claude Edit/Write/MultiEdit file_paths into the repo and skip sidechain files", () => {
  const base = tmp(j(td(), "hubert-cc-edit-"));
  try {
    const root = j(base, "widget"), c = j(base, "claude");
    mk(root); mk(j(c, "-home-red-widget"), { recursive: true });
    const sid = "dd1111-2222-4333-8444-555566667777";
    const abs = (p: string) => j(root, p);
    writeFileSync(j(c, "-home-red-widget", `${sid}.jsonl`), [
      JSON.stringify({ isSidechain: false, type: "assistant", timestamp: "2026-10-08T05:00:00.000Z", cwd: root, message: { role: "assistant", model: "claude-opus-5", content: [
        { type: "tool_use", id: "e", name: "Edit", input: { file_path: abs("src/a.ts"), old_string: "x", new_string: "y" } },
        { type: "tool_use", id: "w", name: "Write", input: { file_path: abs("src/b.ts"), content: "new" } },
        { type: "tool_use", id: "m", name: "MultiEdit", input: { file_path: abs("src/c.ts"), edits: [] } },
        { type: "tool_use", id: "o", name: "Write", input: { file_path: "/home/red/Documents/vault/note.md", content: "x" } },
      ] } }),
    ].join("\n") + "\n");
    writeFileSync(j(c, "-home-red-widget", "agent-ffff.jsonl"), [
      JSON.stringify({ isSidechain: true, type: "assistant", timestamp: "2026-10-08T05:00:01.000Z", cwd: root, message: { role: "assistant", model: "claude-haiku-4-5", content: [
        { type: "tool_use", id: "s", name: "Edit", input: { file_path: abs("src/evil.ts"), old_string: "x", new_string: "y" } },
      ] } }),
    ].join("\n") + "\n");
    const events = editEvents([{ root }], j(base, "none", "jcode"), c, j(base, "none", "codex"));
    expect(events.map((e) => e.path).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(new Set(events.map((e) => e.agent))).toEqual(new Set([`cc-widget-${sid.slice(0, 4)}`]));
    expect(events.every((e) => e.root === root)).toBe(true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
