import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { claudeAgents, jcodeAgents } from "./state";
import { cachedTailLines, clearTailCache } from "./tail-cache";

// A journal or transcript listed by readdir can be unlinked before it is stat'ed: sessions rotate
// while the dashboard polls. A dangling symlink is exactly that state, and it used to make
// collect() reject, which 500ed /api/state and blanked the dashboard.

test("a jcode journal that rotated away mid-scan is skipped, not thrown", () => {
  const dir = mkdtempSync(join(tmpdir(), "hubert-race-"));
  try {
    const live = "session_fixture_0001";
    writeFileSync(join(dir, `${live}.journal.jsonl`), "\n");
    writeFileSync(join(dir, `${live}.json`), JSON.stringify({ short_name: "fixture", working_dir: dir, status: "Active", last_pid: process.pid }));
    symlinkSync(join(dir, "gone"), join(dir, "session_gone_0002.journal.jsonl")); // deleted between readdir and stat

    const agents = jcodeAgents(Date.now(), dir);
    expect(agents.map((a) => a.id)).toEqual([live]);
    expect(agents[0]!.state).toBe("working");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a Claude transcript that rotated away mid-scan is skipped, not thrown", () => {
  const dir = mkdtempSync(join(tmpdir(), "hubert-race-"));
  try {
    mkdirSync(join(dir, "project"));
    writeFileSync(join(dir, "project", "kept.jsonl"), JSON.stringify({ type: "user", cwd: "/home/example/app" }) + "\n");
    symlinkSync(join(dir, "gone"), join(dir, "project", "gone.jsonl"));

    const agents = claudeAgents(Date.now(), dir);
    expect(agents.map((a) => a.cwd)).toEqual(["/home/example/app"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cachedTailLines returns no lines instead of throwing when the path is unreadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "hubert-race-"));
  try {
    clearTailCache();
    expect(cachedTailLines(join(dir, "never-existed.jsonl"), 4096)).toEqual([]);
    expect(cachedTailLines(dir, 4096)).toEqual([]); // stats fine, read fails
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
