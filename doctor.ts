// First-run health check ("doctor"). Pure logic: buildReport() takes every filesystem
// fact through DoctorEnv, so it is testable without touching the real machine.
// realEnv() is the only part that reads this machine. Same report backs GET /api/doctor
// and the `hubert.sh doctor` CLI (renderReport).
import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { sttStatus } from "./voice/stt";

export type DoctorStatus = "ok" | "warn" | "error";
export type DoctorCheck = { id: string; label: string; status: DoctorStatus; detail: string; hint?: string };
export type AgentDirStatus = { id: string; label: string; path: string; found: boolean; sessions: number };
export type DoctorReport = { status: DoctorStatus; port: number; checks: DoctorCheck[]; agents: AgentDirStatus[] };

/** Everything buildReport needs from the outside world, injected so tests never touch disk. */
export type DoctorEnv = {
  port: number;
  which: (bin: string) => boolean;
  speech: () => { active: string | null };
  socketUp: (path: string) => boolean;
  /** Recursive count of files under dir matching match, or null when dir is missing. */
  scan: (dir: string, match: RegExp) => number | null;
  exists: (path: string) => boolean;
  env: (key: string) => string | undefined;
  home: string;
};

export type AgentDir = { id: string; label: string; path: string; match: RegExp; kind?: "dir" | "file" };

const home = (env: DoctorEnv, key: string, fallback: string) => env.env(key) ?? join(env.home, fallback);

/** Data directories Hubert reads sessions from. Keep in sync with state.ts discovery. */
export function agentDirs(env: DoctorEnv): AgentDir[] {
  const data = env.env("XDG_DATA_HOME") ?? join(env.home, ".local", "share");
  return [
    { id: "jcode", label: "jcode", path: join(home(env, "JCODE_HOME", ".jcode"), "sessions"), match: /\.journal\.jsonl$/ },
    { id: "claude", label: "Claude Code", path: join(home(env, "CLAUDE_CONFIG_DIR", ".claude"), "projects"), match: /\.jsonl$/ },
    { id: "codex", label: "Codex", path: join(home(env, "CODEX_HOME", ".codex"), "sessions"), match: /\.jsonl$/ },
    { id: "omp", label: "oh-my-pi", path: join(env.home, ".omp", "agent", "sessions"), match: /\.jsonl$/ },
    { id: "pi", label: "Pi", path: join(env.home, ".pi", "agent", "sessions"), match: /\.jsonl$/ },
    { id: "opencode", label: "OpenCode", path: join(data, "opencode", "opencode.db"), match: /.*/, kind: "file" },
    { id: "cursor", label: "Cursor", path: join(home(env, "CURSOR_HOME", ".cursor"), "projects"), match: /\.jsonl$/ },
  ];
}

/** Socket the jcode api-bridge listens on (matches hubert.sh). */
export function bridgeSocket(env: DoctorEnv): string {
  return env.env("JCODE_API_SOCKET") ?? join(env.env("XDG_RUNTIME_DIR") ?? "/tmp", "jcode-api.sock");
}

const rank: Record<DoctorStatus, number> = { ok: 0, warn: 1, error: 2 };
const worst = (a: DoctorStatus, b: DoctorStatus): DoctorStatus => (rank[a] >= rank[b] ? a : b);

/** Tool check: ok when present, otherwise warn with an install hint. */
const tool = (present: boolean, id: string, label: string, hint: string): DoctorCheck =>
  present ? { id, label, status: "ok", detail: "found on PATH" } : { id, label, status: "warn", detail: "not found", hint };

export function buildReport(env: DoctorEnv): DoctorReport {
  const checks: DoctorCheck[] = [];
  const push = (c: DoctorCheck) => checks.push(c);

  const speech = env.speech();
  push(speech.active
    ? { id: "speech", label: "Speech connector", status: "ok", detail: `active: ${speech.active}` }
    : { id: "speech", label: "Speech connector", status: "warn", detail: "none configured", hint: "set HUBERT_STT to a connector id (see README)" });

  push(tool(env.which("ffmpeg"), "ffmpeg", "ffmpeg", "install ffmpeg to convert browser audio to 16 kHz WAV"));
  push(tool(env.which("tmux"), "tmux", "tmux", "install tmux for terminal-window actions"));
  push(tool(env.which("hyprctl"), "hyprctl", "hyprctl", "install Hyprland to focus agent windows (optional)"));

  const sock = bridgeSocket(env);
  if (!env.which("jcode")) push({ id: "jcode", label: "jcode + api-bridge", status: "warn", detail: "jcode not found on PATH", hint: "install jcode to track and interrupt agents" });
  else if (env.socketUp(sock)) push({ id: "jcode", label: "jcode + api-bridge", status: "ok", detail: `socket up: ${sock}` });
  else push({ id: "jcode", label: "jcode + api-bridge", status: "error", detail: `api-bridge socket not up: ${sock}`, hint: "run hubert.sh to start the bridge (or: jcode api-bridge)" });

  const agents: AgentDirStatus[] = agentDirs(env).map((d) => {
    if (d.kind === "file") { const found = env.exists(d.path); return { id: d.id, label: d.label, path: d.path, found, sessions: found ? 1 : 0 }; }
    const n = env.scan(d.path, d.match);
    return { id: d.id, label: d.label, path: d.path, found: n !== null, sessions: n ?? 0 };
  });
  const found = agents.filter((a) => a.found);
  push(found.length
    ? { id: "agents", label: "Agent data", status: "ok", detail: found.map((a) => `${a.label}: ${a.sessions}`).join(", ") }
    : { id: "agents", label: "Agent data", status: "warn", detail: "no agent data directories found", hint: "run jcode or Claude Code once, or set JCODE_HOME/CLAUDE_CONFIG_DIR" });

  push({ id: "port", label: "Server port", status: "ok", detail: `listening on 127.0.0.1:${env.port}` });

  return { status: checks.reduce((s, c) => worst(s, c.status), "ok" as DoctorStatus), port: env.port, checks, agents };
}

const MARK: Record<DoctorStatus, string> = { ok: "[ok]", warn: "[--]", error: "[!!]" };

/** Plain-text rendering for the CLI: one line per check, hint indented underneath. */
export function renderReport(report: DoctorReport): string {
  const lines = [`hubert doctor: ${report.status}`, `port ${report.port}`, ""];
  for (const c of report.checks) {
    lines.push(`${MARK[c.status]} ${c.label}: ${c.detail}`);
    if (c.hint) lines.push(`     fix: ${c.hint}`);
  }
  lines.push("", "agent data:");
  for (const a of report.agents) lines.push(`  ${a.found ? "yes" : "no "} ${a.label}: ${a.sessions} session(s)  ${a.path}`);
  return lines.join("\n");
}

/** Recursive file count under dir. ponytail: depth cap 6; agent trees are shallow. */
function countFiles(dir: string, match: RegExp, depth = 6): number | null {
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  let n = 0;
  for (const name of names) {
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (depth > 0) n += countFiles(p, match, depth - 1) ?? 0; }
    else if (match.test(name)) n++;
  }
  return n;
}

/** The only machine-touching part. Everything real (Bun.which, fs, env) lives here. */
export function realEnv(port = Number(process.env.HUBERT_PORT ?? 7777)): DoctorEnv {
  return {
    port,
    which: (bin) => Boolean(Bun.which(bin)),
    speech: () => ({ active: sttStatus().active }),
    socketUp: (p) => { try { return statSync(p).isSocket(); } catch { return false; } },
    scan: (dir, match) => countFiles(dir, match),
    exists: (p) => existsSync(p),
    env: (k) => process.env[k]?.trim() || undefined,
    home: homedir(),
  };
}

if (import.meta.main) {
  const report = buildReport(realEnv());
  console.log(renderReport(report));
  process.exit(report.status === "error" ? 1 : 0);
}
