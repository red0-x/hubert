import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { recentCommands, fileDiff, editEvents } from "./live";

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
