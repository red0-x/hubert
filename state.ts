import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";

const HOME = homedir();
const JCODE_SESSIONS = join(HOME, ".jcode/sessions");
const CLAUDE_PROJECTS = join(HOME, ".claude/projects");
const WORKING_MS = 15_000; // journal touched this recently = working
const RECENT_MS = 30 * 60_000; // show non-active sessions touched this recently
const TAIL_BYTES = 64 * 1024;

export type Agent = {
  id: string;
  name: string;
  source: "jcode" | "claude";
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
  const agents = [...jcodeAgents(now), ...claudeAgents(now)].sort((a, b) => b.lastActive - a.lastActive);
  const repos = new Map<string, Repo>();
  for (const a of agents) {
    a.repo = a.cwd ? repoRoot(a.cwd) : null;
    if (!a.repo || a.state === "closed" || a.state === "crashed") continue;
    if (!repos.has(a.repo)) repos.set(a.repo, { ...repoInfo(a.repo), agents: [] });
    repos.get(a.repo)!.agents.push(a.name);
  }
  return { now, agents, repos: [...repos.values()] };
}
