import { readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, relative, resolve, sep } from "path";
import { cachedTailLines, memo } from "./tail-cache";
import { isSidechainTranscript } from "./state";

// ponytail: one second, matching the client's 1.5s poll; the polled endpoints share one scan
const LIVE_TTL = 1000;

export type Command = {
  agent: string;
  source: "jcode" | "claude" | "codex";
  tool: "bash" | "Bash" | "exec";
  command: string;
  intent?: string;
  // Undefined when the transcript gives no real evidence either way (see codexCommands).
  ok?: boolean;
  error?: string;
  duration_ms?: number;
  ts: number;
};

export type EditEvent = { agent: string; root: string; path: string; ts: number };

/** Count actual file-edit tool calls in recent journal tails, not git status snapshots. Cached for a second per repo set. */
export function editEvents(repos: { root: string }[],
  jcodeDir = join(process.env.JCODE_HOME ?? join(homedir(), ".jcode"), "sessions"),
  claudeDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"),
  codexDir = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")): EditEvent[] {
  const key = `edits\u0000${repos.map((r) => r.root).join("\u0000")}\u0000${jcodeDir}\u0000${claudeDir}\u0000${codexDir}`;
  return memo(key, LIVE_TTL, () => editEventsOnce(repos, jcodeDir, claudeDir, codexDir));
}

function editEventsOnce(repos: { root: string }[], jcodeDir: string, claudeDir: string, codexDir: string): EditEvent[] {
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
      const rows = cachedTailLines(path, TAIL_BYTES);
      if (source === "claude" && isSidechainTranscript(rows)) continue; // subagent runs are not separate top-level agents
      if (source === "claude") {
        // A session records many cwds as commands cd around; use the newest so one session maps to one stable agent name.
        cwd = rows.findLast((r) => r.cwd)?.cwd ?? cwd;
        if (cwd) agent = `cc-${basename(cwd)}-${basename(path).slice(0, 4)}`;
      }
      for (const row of rows) {
        if (source === "jcode") { cwd = row.meta?.working_dir ?? row.cwd ?? cwd; agent = row.meta?.short_name ?? agent; }
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
  events.push(...codexEdits(repos, codexDir));
  return events.sort((x, y) => x.ts - y.ts).slice(-500);
}

/** Recent Codex rollout files, newest first. Layout is sessions/YYYY/MM/DD/rollout-*.jsonl. */
function codexRollouts(dir: string): string[] {
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[]; try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const path = join(d, n);
      try {
        if (statSync(path).isDirectory()) { if (depth > 0) walk(path, depth - 1); }
        else if (n.endsWith(".jsonl") && Date.now() - statSync(path).mtimeMs < RECENT_MS) files.push(path);
      } catch {}
    }
  };
  walk(dir, 3);
  const mtime = (p: string) => { try { return statSync(p).mtimeMs; } catch { return 0; }; };
  return files.sort((a, b) => mtime(b) - mtime(a));
}

/** Codex records applied patches as event_msg/patch_apply_end with absolute paths and a success flag. Edits made through shell commands are not seen. */
export function codexEdits(repos: { root: string }[], dir = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")): EditEvent[] {
  const out: EditEvent[] = [];
  for (const path of codexRollouts(dir).slice(0, 8)) {
    try {
      const fallback = statSync(path).mtimeMs;
      let cwd = "";
      for (const row of cachedTailLines(path, TAIL_BYTES)) {
        if (row.type === "turn_context") cwd = row.payload?.cwd ?? cwd;
        if (row.type !== "event_msg" || row.payload?.type !== "patch_apply_end" || row.payload.success !== true) continue;
        const agent = `cx-${basename(cwd || "codex")}-${basename(path, ".jsonl").slice(-36, -32)}`;
        const changes = row.payload.changes;
        if (!changes || typeof changes !== "object") continue;
        for (const file of Object.keys(changes)) {
          const absolute = resolve(cwd, file);
          const repo = repos.find((r) => absolute.startsWith(r.root + sep));
          if (repo) out.push({ agent, root: repo.root, path: relative(repo.root, absolute), ts: Date.parse(row.timestamp ?? "") || fallback });
        }
      }
    } catch {} // Rollouts rotate or carry malformed lines; one bad row must not drop the rest.
  }
  return out;
}

/**
 * Recent shell commands from Codex rollouts. The exec tool runs a JS cell whose recorded output is
 * prefixed with "Script completed|Script error|Script running with cell ID" plus a wall-time line.
 * That prefix is the only completion evidence in the transcript: a "Script error" cell is a real
 * failure, but "Script completed" only proves the cell finished, not the shell exit code, so ok stays
 * undefined unless the cell errored. Commands run through the async `wait` flow are not paired back.
 */
export function codexCommands(dir = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")): Command[] {
  const out: Command[] = [];
  for (const path of codexRollouts(dir).slice(0, 8)) {
    try {
      const fallback = statSync(path).mtimeMs;
      const stem = basename(path, ".jsonl").slice(-36, -32);
      let cwd = "";
      const pending = new Map<string, Command>();
      for (const row of cachedTailLines(path, TAIL_BYTES)) {
        if (row.type === "turn_context") { cwd = row.payload?.cwd ?? cwd; continue; }
        const p = row.type === "response_item" ? row.payload : null;
        if (!p || typeof p.call_id !== "string") continue;
        const ts = Date.parse(row.timestamp ?? "") || fallback;
        if (p.type === "custom_tool_call" && p.name === "exec") {
          const command = execCommand(p.input);
          if (command) pending.set(p.call_id, { agent: `cx-${basename(cwd || "codex")}-${stem}`, source: "codex", tool: "exec", command, ts });
        } else if (p.type === "custom_tool_call_output") {
          const call = pending.get(p.call_id);
          if (!call) continue;
          pending.delete(p.call_id);
          const raw = typeof p.output === "string" ? p.output : Array.isArray(p.output) ? p.output.map((o: any) => o.text ?? "").join("") : "";
          const seconds = /Wall time ([\d.]+) seconds/.exec(raw);
          if (seconds) call.duration_ms = Math.round(parseFloat(seconds[1]!) * 1000);
          if (/^Script error:/.test(raw)) {
            call.ok = false;
            call.error = raw.replace(/^[^\n]*\nWall time [\d.]+ seconds\n(?:Output:\n)?/, "").slice(0, 1000);
          }
          out.push(call);
        }
      }
    } catch {} // Rollouts may rotate or be malformed.
  }
  return out;
}

/** Codex passes the shell command inside a JS cell as JSON: tools.exec_command({"cmd":"...", ...}). */
function execCommand(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const match = /"cmd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(input);
  if (!match) return undefined;
  try { const cmd: unknown = JSON.parse(match[1]!); return typeof cmd === "string" && cmd.trim() ? cmd : undefined; } catch { return undefined; }
}


const RECENT_MS = 30 * 60_000;
const TAIL_BYTES = 256 * 1024;

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
  codexDir = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
): Command[] {
  // /api/commands and /api/command-stats are separate polls of the same scan; share one result per second.
  return memo(`commands\u0000${jcodeDir}\u0000${claudeDir}\u0000${codexDir}`, LIVE_TTL, () => recentCommandsOnce(jcodeDir, claudeDir, codexDir));
}

function recentCommandsOnce(jcodeDir: string, claudeDir: string, codexDir: string): Command[] {
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
      const events = cachedTailLines(path, TAIL_BYTES);
      if (source === "claude" && isSidechainTranscript(events)) continue; // subagent runs are not separate top-level agents
      if (source === "claude") {
        // A session records many cwds as commands cd around; pick one so every command from it carries the same agent name.
        const cwd = events.findLast((e) => e.cwd)?.cwd;
        if (cwd) agent = `cc-${basename(cwd)}-${basename(path).slice(0, 4)}`;
      }
      for (const event of events) {
        if (source === "jcode") agent = event.meta?.short_name ?? agent;
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
  results.push(...codexCommands(codexDir));
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
