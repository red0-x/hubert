import { closeSync, openSync, readSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, relative, resolve, sep } from "path";

export type Command = {
  agent: string;
  source: "jcode" | "claude";
  tool: "bash" | "Bash";
  command: string;
  intent?: string;
  ok: boolean;
  error?: string;
  duration_ms?: number;
  ts: number;
};

const RECENT_MS = 30 * 60_000;
const TAIL_BYTES = 256 * 1024;

function tail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { closeSync(fd); }
}

function recentFiles(dir: string, suffix: string): string[] {
  try {
    return readdirSync(dir).filter(name => name.endsWith(suffix)).map(name => join(dir, name))
      .filter(path => { try { return Date.now() - statSync(path).mtimeMs < RECENT_MS; } catch { return false; } })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 12);
  } catch { return []; }
}

/** Last 50 completed bash calls from recent Jcode journals and Claude transcripts. */
export function recentCommands(
  jcodeDir = join(process.env.JCODE_HOME ?? join(homedir(), ".jcode"), "sessions"),
  claudeDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"),
): Command[] {
  const files: { path: string; source: Command["source"] }[] = recentFiles(jcodeDir, ".journal.jsonl").map(path => ({ path, source: "jcode" }));
  try {
    for (const dir of readdirSync(claudeDir)) {
      for (const path of recentFiles(join(claudeDir, dir), ".jsonl")) files.push({ path, source: "claude" });
    }
  } catch {}
  const results: Command[] = [];
  for (const { path, source } of files.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs).slice(0, 24)) {
    try {
      const pending = new Map<string, Command>();
      const fallback = statSync(path).mtimeMs;
      for (const line of tail(path).split("\n")) {
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        const messages = source === "jcode" ? event.append_messages ?? [] : [event.message];
        const timestamp = Date.parse(event.timestamp ?? "") || fallback;
        for (const message of messages) {
          if (!Array.isArray(message?.content)) continue;
          for (const block of message.content) {
            if (block.type === "tool_use" && (block.name === "bash" || block.name === "Bash") && typeof block.input?.command === "string" && typeof block.id === "string") {
              pending.set(block.id, { agent: basename(path).replace(/\.journal\.jsonl$|\.jsonl$/, ""), source, tool: block.name, command: block.input.command, intent: block.input.intent ?? block.input.description, ok: true, ts: timestamp });
            } else if (block.type === "tool_result" && pending.has(block.tool_use_id)) {
              const command = pending.get(block.tool_use_id)!;
              pending.delete(block.tool_use_id);
              const output = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((part: any) => part.text ?? "").join("\n") : "";
              command.ok = block.is_error !== true && !/Command finished with exit code: [1-9]\d*/.test(output);
              if (!command.ok) command.error = output.slice(0, 1000);
              const duration = message.tool_duration_ms ?? (source === "claude" ? timestamp - command.ts : undefined);
              if (typeof duration === "number" && duration >= 0) command.duration_ms = duration;
              results.push(command);
            }
          }
        }
      }
    } catch {} // Journals may disappear while sessions rotate.
  }
  return results.sort((a, b) => b.ts - a.ts).slice(0, 50);
}

function git(root: string, ...args: string[]): Buffer {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stderr: "ignore" });
  if (result.exitCode !== 0) throw new Error("git operation failed");
  return Buffer.from(result.stdout);
}

/** Diff a changed tracked file against HEAD, or return bounded untracked contents. */
export function fileDiff(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).some(part => part === ".." || part === "." || part === ".git")) throw new Error("invalid path");
  const repo = realpathSync(root);
  if (git(repo, "rev-parse", "--show-toplevel").toString().trim() !== repo) throw new Error("invalid repo root");
  const absolute = resolve(repo, path);
  const rel = relative(repo, absolute);
  if (!rel || rel.startsWith(".." + sep) || rel === "..") throw new Error("invalid path");
  const entries = git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", rel).toString().split("\0");
  let status: string | undefined;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const name = entry.slice(3);
    if (name === rel) status = code;
    if (code.includes("R") || code.includes("C")) i++; // -z follows a rename with its old path.
  }
  if (!status) throw new Error("file is not changed");
  if (status === "??") {
    const actual = realpathSync(absolute);
    if (actual !== repo && !actual.startsWith(repo + sep)) throw new Error("path escapes repo");
    if (!statSync(actual).isFile() || statSync(actual).size > 1024 * 1024) throw new Error("untracked file is not a small regular file");
    return readFileSync(actual, "utf8");
  }
  return git(repo, "diff", "HEAD", "--", rel).toString();
}
