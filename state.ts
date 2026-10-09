import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync, existsSync } from "fs";
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join, basename } from "path";

const HOME = homedir();
const JCODE_SESSIONS = join(process.env.JCODE_HOME ?? join(HOME, ".jcode"), "sessions");
const CLAUDE_PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"), "projects");
const WORKING_MS = 15_000; // journal touched this recently = working
const RECENT_MS = 30 * 60_000; // show non-active sessions touched this recently
const TAIL_BYTES = 64 * 1024;
/** Prompts that start with this are hubert's own brain calls, so they are not shown as agents. */
export const BRAIN_MARK = "HUBERT-BRAIN";

export type Agent = {
  id: string;
  name: string;
  source: "jcode" | "claude" | "codex" | "omp" | "pi" | "opencode" | "cursor";
  cwd: string;
  repo: string | null;
  model?: string;
  title?: string;
  parent?: string | null;
  state: "working" | "idle" | "closed" | "crashed";
  doing?: string; // last tool intent/description
  lastActive: number;
};

export type FileChange = { path: string; status: string; add: number; del: number };
export type Repo = { root: string; name: string; branch: string; files: FileChange[]; agents: string[] };

function tail(path: string, bytes = TAIL_BYTES): string {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Parse the tail of a JSONL file; first line may be partial so bad lines are skipped. */
export function jsonLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

/** Last tool_use in a list of messages-with-content, as a short human string. */
export function lastTool(contents: any[][]): string | undefined {
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (!Array.isArray(c)) continue;
    for (let j = c.length - 1; j >= 0; j--) {
      const b = c[j];
      if (b?.type !== "tool_use") continue;
      const inp = b.input ?? {};
      const what = inp.intent ?? inp.description ?? inp.file_path ?? inp.command ?? inp.pattern ?? "";
      return `${b.name}${what ? ": " + String(what).slice(0, 120) : ""}`;
    }
  }
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const metaCache = new Map<string, { mtime: number; meta: any }>();
function jcodeMeta(jsonPath: string): any {
  let mtime: number;
  try { mtime = statSync(jsonPath).mtimeMs; } catch { return {}; }
  const hit = metaCache.get(jsonPath);
  if (hit && hit.mtime === mtime) return hit.meta;
  let meta: any = {};
  try {
    const { messages, env_snapshots, ...rest } = JSON.parse(readFileSync(jsonPath, "utf8"));
    meta = rest;
  } catch {}
  metaCache.set(jsonPath, { mtime, meta });
  return meta;
}

function jcodeAgents(now: number): Agent[] {
  let files: string[];
  try { files = readdirSync(JCODE_SESSIONS); } catch { return []; }
  const agents: Agent[] = [];
  for (const f of files) {
    if (!f.endsWith(".journal.jsonl")) continue;
    const journal = join(JCODE_SESSIONS, f);
    const id = f.slice(0, -".journal.jsonl".length);
    const mtime = statSync(journal).mtimeMs;
    const base = jcodeMeta(join(JCODE_SESSIONS, id + ".json"));
    // ponytail: skips any session untouched for 30min unless meta says Active; 194 files stat is cheap
    if (now - mtime > RECENT_MS && base.status !== "Active") continue;
    const lines = jsonLines(tail(journal));
    const meta = { ...base, ...(lines.findLast((l) => l.meta)?.meta ?? {}) };
    const status = meta.status;
    if (typeof meta.title === "string" && meta.title.startsWith(BRAIN_MARK)) continue;
    const crashed = typeof status === "object" && status && "Crashed" in status;
    if (status !== "Active" && !crashed && now - mtime > RECENT_MS) continue;
    const live = status === "Active" && alive(meta.last_pid);
    if (status === "Active" && !live && now - mtime > RECENT_MS) continue;
    const state: Agent["state"] = crashed ? "crashed" : !live ? "closed" : now - mtime < WORKING_MS ? "working" : "idle";
    agents.push({
      id,
      name: meta.short_name ?? id,
      source: "jcode",
      cwd: meta.working_dir ?? "",
      repo: null,
      model: meta.model,
      title: meta.title,
      parent: meta.parent_id ?? null,
      state,
      doing: lastTool(lines.flatMap((l) => (l.append_messages ?? []).map((m: any) => m.content))),
      lastActive: mtime,
    });
  }
  return agents;
}

function claudeAgents(now: number): Agent[] {
  let dirs: string[];
  try { dirs = readdirSync(CLAUDE_PROJECTS); } catch { return []; }
  const agents: Agent[] = [];
  for (const d of dirs) {
    let files: string[];
    try { files = readdirSync(join(CLAUDE_PROJECTS, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(CLAUDE_PROJECTS, d, f);
      const mtime = statSync(p).mtimeMs;
      if (now - mtime > RECENT_MS) continue;
      const lines = jsonLines(tail(p));
      const cwd = lines.findLast((l) => l.cwd)?.cwd;
      if (!cwd) continue;
      const id = f.slice(0, -6);
      agents.push({
        id,
        name: `cc-${basename(cwd)}-${id.slice(0, 4)}`,
        source: "claude",
        cwd,
        repo: null,
        model: lines.findLast((l) => l.message?.model)?.message.model,
        state: now - mtime < WORKING_MS ? "working" : "idle",
        doing: lastTool(lines.filter((l) => l.type === "assistant").map((l) => l.message?.content)),
        lastActive: mtime,
      });
    }
  }
  return agents;
}

// ---- Other agents. Discovery only: state, repo, model, last tool. Codex and Claude formats were checked against real files; omp, pi, opencode and cursor follow their documented layouts and are untested on a real install. ----

function head(path: string, bytes = 64 * 1024): string {
  const fd = openSync(path, "r");
  try { const buf = Buffer.alloc(Math.min(statSync(path).size, bytes)); readSync(fd, buf, 0, buf.length, 0); return buf.toString("utf8"); } finally { closeSync(fd); }
}

/** Recently modified files under `dir` matching `want`, at most `depth` directory levels down. */
function recentFiles(dir: string, depth: number, want: (name: string) => boolean, now: number): { path: string; mtime: number }[] {
  const out: { path: string; mtime: number }[] = [];
  const walk = (d: string, left: number) => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (left > 0) walk(p, left - 1); }
      else if (want(n) && now - st.mtimeMs < RECENT_MS) out.push({ path: p, mtime: st.mtimeMs });
    }
  };
  walk(dir, depth);
  return out;
}

const state = (now: number, mtime: number): Agent["state"] => (now - mtime < WORKING_MS ? "working" : "idle");
const short = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").slice(0, 120);

/** Last tool call in Codex rollout lines: function_call (JSON args) or custom_tool_call (JS source containing "cmd"). */
export function codexDoing(lines: any[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = lines[i]?.type === "response_item" ? lines[i].payload : null;
    if (p?.type !== "function_call" && p?.type !== "custom_tool_call") continue;
    let what = "";
    try { const a = JSON.parse(p.arguments); what = a.cmd ?? a.command ?? ""; } catch {}
    what ||= /"cmd":"((?:[^"\\]|\\.){1,160})/.exec(String(p.input ?? p.arguments ?? ""))?.[1] ?? "";
    return `${p.name}${what ? ": " + short(what) : ""}`;
  }
}

function codexAgents(now: number): Agent[] {
  const root = join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "sessions");
  const files: { path: string; mtime: number }[] = [];
  for (let back = 0; back < 3; back++) {
    const d = new Date(now - back * 86_400_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    files.push(...recentFiles(join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())), 0, n => n.endsWith(".jsonl"), now));
  }
  const agents: Agent[] = [];
  for (const { path, mtime } of files) {
    try {
      const lines = jsonLines(tail(path));
      const meta = jsonLines(head(path).split("\n")[0] ?? "")[0]?.payload;
      const cwd: string = lines.findLast((l) => l.type === "turn_context")?.payload?.cwd ?? meta?.cwd ?? "";
      const id: string = meta?.id ?? /([0-9a-f-]{36})\.jsonl$/.exec(path)?.[1] ?? basename(path);
      if (!cwd) continue;
      agents.push({ id, name: `cx-${basename(cwd)}-${id.slice(0, 4)}`, source: "codex", cwd, repo: null, model: (lines.findLast((l) => l.type === "turn_context") ?? jsonLines(head(path)).find((l) => l.type === "turn_context"))?.payload?.model,
        state: state(now, mtime), doing: codexDoing(lines), lastActive: mtime });
    } catch {}
  }
  return agents;
}

/** omp and pi share one JSONL format: header {type:"session",id,cwd} (omp precedes it with a title slot), then message entries. */
export function piDoing(lines: any[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const b of [...(lines[i]?.message?.content ?? [])].reverse()) {
      if (b?.type === "toolCall" || b?.type === "tool_use") {
        const a = b.arguments ?? b.input ?? {};
        const what = a.command ?? a.cmd ?? a.path ?? a.file_path ?? a.pattern ?? "";
        return `${b.name}${what ? ": " + short(what) : ""}`;
      }
    }
  }
}

function piAgents(now: number, source: "omp" | "pi", root: string): Agent[] {
  const agents: Agent[] = [];
  for (const { path, mtime } of recentFiles(root, 2, n => n.endsWith(".jsonl"), now)) {
    try {
      const header = jsonLines(head(path, 8192)).find((l) => l.type === "session");
      if (!header?.cwd || header.parentSession) continue; // subagent runs would flood the list
      const lines = jsonLines(tail(path));
      const id: string = header.id ?? basename(path, ".jsonl");
      agents.push({ id, name: `${source}-${basename(header.cwd)}-${id.slice(0, 4)}`, source, cwd: header.cwd, repo: null,
        model: lines.findLast((l) => l.message?.model)?.message.model, state: state(now, mtime), doing: piDoing(lines), lastActive: mtime });
    } catch {}
  }
  return agents;
}

/** OpenCode 1.17+ keeps sessions in SQLite. Older JSON stores are not read. */
function opencodeAgents(now: number): Agent[] {
  const db = join(process.env.XDG_DATA_HOME ?? join(HOME, ".local/share"), "opencode", "opencode.db");
  if (!existsSync(db)) return [];
  let conn: Database | undefined;
  try {
    conn = new Database(db, { readonly: true });
    const rows = conn.query("SELECT id, title, directory, parent_id, model, time_updated FROM session WHERE time_archived IS NULL AND time_updated > ? AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 20").all(now - RECENT_MS) as any[];
    return rows.map((r) => {
      let model: string | undefined; try { model = JSON.parse(r.model)?.id; } catch {}
      return { id: r.id, name: `oc-${basename(r.directory)}-${String(r.id).slice(-4)}`, source: "opencode" as const, cwd: r.directory, repo: null, model, title: r.title,
        state: state(now, r.time_updated), doing: r.title ? short(r.title) : undefined, lastActive: r.time_updated };
    });
  } catch { return []; } finally { conn?.close(); }
}

/** Cursor project folders are the cwd with "/" and "." turned into "-", which is ambiguous. Resolve by walking real directories. */
export function resolveSlug(slug: string, base = "/"): string | null {
  const parts = slug.split("-");
  const go = (dir: string, i: number): string | null => {
    if (i === parts.length) return dir;
    for (let j = parts.length; j > i; j--) {
      for (const name of [parts.slice(i, j).join("-"), "." + parts.slice(i, j).join("-")]) {
        const next = join(dir, name);
        if (existsSync(next)) { const r = go(next, j); if (r) return r; }
      }
    }
    return null;
  };
  return go(base, 0);
}

function cursorAgents(now: number): Agent[] {
  const root = join(process.env.CURSOR_HOME ?? join(HOME, ".cursor"), "projects");
  const agents: Agent[] = [];
  for (const { path, mtime } of recentFiles(root, 4, n => n.endsWith(".jsonl"), now)) {
    const rel = path.slice(root.length + 1).split("/");
    if (rel[1] !== "agent-transcripts" || rel.includes("subagents")) continue;
    const cwd = resolveSlug(rel[0]!); if (!cwd) continue;
    try {
      const lines = jsonLines(tail(path));
      const id = basename(path, ".jsonl");
      agents.push({ id, name: `cur-${basename(cwd)}-${id.slice(0, 4)}`, source: "cursor", cwd, repo: null, state: state(now, mtime),
        doing: lastTool(lines.map((l) => l.message?.content)), lastActive: mtime });
    } catch {}
  }
  return agents;
}

function git(cwd: string, args: string[]): string | null {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

const rootCache = new Map<string, string | null>();
function repoRoot(cwd: string): string | null {
  if (!rootCache.has(cwd)) rootCache.set(cwd, git(cwd, ["rev-parse", "--show-toplevel"])?.trim() || null);
  return rootCache.get(cwd)!;
}

/** Merge `git status --porcelain` and `git diff --numstat HEAD` output. */
export function parseChanges(porcelain: string, numstat: string): FileChange[] {
  const counts = new Map<string, [number, number]>();
  for (const line of numstat.split("\n")) {
    const [a, d, ...rest] = line.split("\t");
    if (rest.length) counts.set(rest.join("\t"), [Number(a) || 0, Number(d) || 0]);
  }
  const files: FileChange[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4 || line.startsWith("##")) continue;
    let path = line.slice(3);
    if (path.includes(" -> ")) path = path.split(" -> ")[1]!;
    const [add, del] = counts.get(path) ?? [0, 0];
    files.push({ path, status: line.slice(0, 2).trim() || "?", add, del });
  }
  return files;
}

function repoInfo(root: string): Omit<Repo, "agents"> {
  const porcelain = git(root, ["status", "--porcelain=v1", "-b", "--untracked-files=all"]) ?? "";
  const numstat = git(root, ["diff", "--numstat", "HEAD"]) ?? "";
  const branch = porcelain.match(/^## (?:No commits yet on )?([^.\s]+)/)?.[1] ?? "?";
  return { root, name: basename(root), branch, files: parseChanges(porcelain, numstat) };
}

export function collect() {
  const now = Date.now();
  const piRoot = (dir: string) => join(HOME, dir, "agent", "sessions");
  const agents = [...jcodeAgents(now), ...claudeAgents(now), ...codexAgents(now), ...piAgents(now, "omp", piRoot(".omp")), ...piAgents(now, "pi", piRoot(".pi")), ...opencodeAgents(now), ...cursorAgents(now)].sort((a, b) => b.lastActive - a.lastActive);
  const repos = new Map<string, Repo>();
  for (const a of agents) {
    a.repo = a.cwd ? repoRoot(a.cwd) : null;
    if (!a.repo || a.state === "closed" || a.state === "crashed") continue;
    if (!repos.has(a.repo)) repos.set(a.repo, { ...repoInfo(a.repo), agents: [] });
    repos.get(a.repo)!.agents.push(a.name);
  }
  return { now, agents, repos: [...repos.values()] };
}
