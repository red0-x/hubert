import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { recentCommands, fileDiff } from "./live";

const git = (root: string, ...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args], { stderr: "pipe" });

test("recentCommands joins only completed bash calls across recent sessions", () => {
  const base = mkdtempSync(join(tmpdir(), "hubert-live-"));
  try {
    const j = join(base, "jcode"), c = join(base, "claude");
    mkdirSync(j); mkdirSync(join(c, "project"), { recursive: true });
    const lines = [
      { append_messages: [{ role: "assistant", content: [{ type: "tool_use", id: "one", name: "bash", input: { command: "echo one", intent: "say one" } }, { type: "tool_use", id: "pending", name: "bash", input: { command: "not done" } }] }] },
      { append_messages: [{ role: "user", tool_duration_ms: 23, content: [{ type: "tool_result", tool_use_id: "one", content: "ok" }] }] },
    ];
    writeFileSync(join(j, "session.journal.jsonl"), lines.map(x => JSON.stringify(x)).join("\n") + "\n");
    writeFileSync(join(c, "project", "session.jsonl"), [
      { type: "assistant", timestamp: "2026-10-08T05:00:00Z", message: { content: [{ type: "tool_use", id: "two", name: "Bash", input: { command: "false", description: "fail" } }] } },
      { type: "user", timestamp: "2026-10-08T05:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "two", is_error: true, content: "failed" }] } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    const commands = recentCommands(j, c);
    expect(commands.map(x => x.command).sort()).toEqual(["echo one", "false"]);
    expect(commands.find(x => x.command === "echo one")).toMatchObject({ agent: "session", source: "jcode", ok: true, duration_ms: 23, intent: "say one" });
    expect(commands.find(x => x.command === "false")).toMatchObject({ source: "claude", ok: false, error: "failed", duration_ms: 1000 });
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});
