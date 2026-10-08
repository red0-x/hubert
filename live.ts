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

export type EditEvent = { agent: string; root: string; path: string; ts: number };

/** Count actual file-edit tool calls in recent journal tails, not git status snapshots. */
export function editEvents(repos: { root: string }[],
  jcodeDir = join(process.env.JCODE_HOME ?? join(homedir(), ".jcode"), "sessions"),
  claudeDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects")): EditEvent[] {
  const files = recentFiles(jcodeDir, ".journal.jsonl").map(path => ({ path, source: "jcode" }));
  try { for (const dir of readdirSync(claudeDir)) for (const path of recentFiles(join(claudeDir, dir), ".jsonl")) files.push({ path, source: "claude" }); } catch {}
  const events: EditEvent[] = [];
  for (const { path, source } of files.slice(0, 24)) {
    let cwd = "";
    let agent = basename(path).replace(/\.journal\.jsonl$|\.jsonl$/, "");
    try {
      if (source === "jcode") {
        const meta = JSON.parse(readFileSync(path.replace(/\.journal\.jsonl$/, ".json"), "utf8"));
        cwd = meta.working_dir ?? "";
        agent = meta.short_name ?? agent;
      }
      for (const line of tail(path).split("\n")) {
        let row: any;
        try { row = JSON.parse(line); } catch { continue; }
        cwd = row.meta?.working_dir ?? row.cwd ?? cwd;
        if (source === "jcode") agent = row.meta?.short_name ?? agent;
        else if (cwd) agent = `cc-${basename(cwd)}-${basename(path).slice(0, 4)}`;
        const messages = source === "jcode" ? row.append_messages : [row.message];
        if (!Array.isArray(messages)) continue;
        for (const message of messages) for (const block of Array.isArray(message?.content) ? message.content : []) {
          if (block?.type !== "tool_use") continue;
          const input = block.input ?? {};
          let paths: string[] = [];
          if (["edit", "write", "read"].includes(block.name) && block.name !== "read" && typeof input.file_path === "string") paths = [input.file_path];
          if (["apply_patch", "Edit", "Write", "MultiEdit"].includes(block.name)) {
            if (typeof input.file_path === "string") paths.push(input.file_path);
            if (typeof input.patch_text === "string") paths.push(...[...input.patch_text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1]!));
            if (typeof input.patch === "string") paths.push(...[...input.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1]!));
          }
          for (const p of new Set(paths)) {
            const absolute = resolve(cwd, p);
            const repo = repos.find(r => absolute.startsWith(r.root + sep));
            if (repo) events.push({ agent, root: repo.root, path: relative(repo.root, absolute), ts: Date.parse(row.timestamp ?? "") || statSync(path).mtimeMs });
          }
        }
      }
    } catch {} // Rotating or malformed journals are not fatal.
  }
  return events.slice(-500);
}

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
      let agent = basename(path).replace(/\.journal\.jsonl$|\.jsonl$/, "");
      if (source === "jcode") {
        try { agent = JSON.parse(readFileSync(path.replace(/\.journal\.jsonl$/, ".json"), "utf8")).short_name ?? agent; } catch {}
      }
      for (const line of tail(path).split("\n")) {
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        if (source === "jcode") agent = event.meta?.short_name ?? agent;
        else if (event.cwd) agent = `cc-${basename(event.cwd)}-${basename(path).slice(0, 4)}`;
        const messages = source === "jcode" ? event.append_messages ?? [] : [event.message];
        const timestamp = Date.parse(event.timestamp ?? "") || fallback;
        for (const message of messages) {
          if (!Array.isArray(message?.content)) continue;
          for (const block of message.content) {
            if (block.type === "tool_use" && (block.name === "bash" || block.name === "Bash") && typeof block.input?.command === "string" && typeof block.id === "string") {
              pending.set(block.id, { agent, source, tool: block.name, command: block.input.command, intent: block.input.intent ?? block.input.description, ok: true, ts: timestamp });
            } else if (block.type === "tool_result" && pending.has(block.tool_use_id)) {
              const command = pending.get(block.tool_use_id)!;
              pending.delete(block.tool_use_id);
              const output = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((part: any) => part.text ?? "").join("\n") : "";
              command.ok = block.is_error !== true && !/(?:\n\nExit code:|\bCommand finished with exit code:)\s*[1-9]\d*\s*$/i.test(output);
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
