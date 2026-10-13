import type { Command } from "./live";

// Short/long flags that consume the following token, so it is not mistaken for a subcommand or argument.
const VALUE_FLAGS = new Set(["-m", "--message", "-C", "--directory", "-c", "--config", "-o", "--output", "-f", "--file", "-e", "--eval", "--filter", "--target", "--root", "--port", "--cwd", "--workdir", "--prefix", "--pattern", "--name", "--test", "--dir"]);

// CLIs where the first positional token is the meaningful subcommand.
const KNOWN = new Set(["git", "bun", "npm", "pnpm", "yarn", "npx", "cargo", "rustc", "go", "make", "cmake", "docker", "kubectl", "pip", "pip3", "python", "python3", "node", "deno", "tsc", "vitest", "jest", "curl", "gh"]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const SCRIPT_SUBS = new Set(["run", "exec", "dlx"]);

function commandName(segment: string): string {
  const first = segment.trim().split(/\s+/)[0] ?? "";
  return first.split("/").pop() ?? first;
}

function isPathToken(token: string): boolean {
  if (token.startsWith("./") || token.startsWith("../") || token.startsWith("/") || token.startsWith("~")) return true;
  if (token.includes("/")) return true;
  return /^[\w.-]+\.[A-Za-z][\w]*$/.test(token);
}

function classify(token: string): string {
  return isPathToken(token) ? "<path>" : token;
}

function isFlag(token: string): boolean {
  return token.startsWith("-") && token !== "-" && token !== "--";
}

/** First positional token after the command name, skipping flags and the values of value-taking flags. */
function subcommand(tokens: string[]): string | undefined {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isFlag(token)) {
      if (VALUE_FLAGS.has(token) && !token.includes("=")) i++;
      continue;
    }
    return token;
  }
  return undefined;
}

function classifyArgs(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isFlag(token)) {
      if (VALUE_FLAGS.has(token) && !token.includes("=")) i++;
      continue;
    }
    const part = classify(token);
    if (part === "<path>" && out[out.length - 1] === "<path>") continue;
    out.push(part);
  }
  return out;
}

/**
 * Reduce a shell command to a stable label: `git status`, `bun test`, `npm run build`, `pytest <path>`.
 * Small and pure so the retry and aggregation logic below stays testable. The first segment of a
 * `cd x && bun test` chain wins when it names a known CLI, so wrapper commands do not hide the real one.
 */
export function normalizeCommand(raw: string): string {
  const line = (raw ?? "").split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  if (!line) return "";
  const segments = line.split(/&&|\|\||;/).map((part) => part.trim()).filter(Boolean);
  let picked = segments[0] ?? line;
  for (const segment of segments) if (KNOWN.has(commandName(segment))) { picked = segment; break; }
  // `cd <dir> && real-command` is extremely common; do not let the wrapper hide the real command.
  if (commandName(picked) === "cd" && segments.length > 1) picked = segments[segments.length - 1]!;
  const tokens = picked.split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  const name = commandName(picked);
  if (!KNOWN.has(name)) return [name, ...classifyArgs(tokens)].join(" ").trim();
  if (PACKAGE_MANAGERS.has(name)) {
    const sub = subcommand(tokens);
    if (sub && SCRIPT_SUBS.has(sub)) {
      const rest = tokens.slice(tokens.indexOf(sub) + 1).find((token) => !isFlag(token));
      return [name, sub, rest ? classify(rest) : ""].filter(Boolean).join(" ");
    }
    return sub ? `${name} ${classify(sub)}` : name;
  }
  const sub = subcommand(tokens);
  return sub ? `${name} ${classify(sub)}` : name;
}

export function firstErrorLine(error?: string): string {
  const line = (error ?? "").split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** Nearest-rank percentile over an ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

export type NormStat = { command: string; count: number; failed: number };
export type RetryLoop = { agent: string; command: string; count: number; lastTs: number };
export type CommandStats = {
  total: number;
  failed: number;
  mostSent: NormStat[];
  mostFailed: NormStat[];
  topErrors: { error: string; count: number }[];
  longest: { agent: string; command: string; normalized: string; duration_ms: number; ts: number }[];
  durations: { command: string; count: number; p50: number; p95: number; max: number }[];
  retryLoops: RetryLoop[];
};

/** Same normalized command failing repeatedly for one agent: the stuck-loop signal. */
export function retryLoops(commands: Command[], threshold = 3): RetryLoop[] {
  const loops = new Map<string, RetryLoop>();
  for (const command of commands) {
    if (command.ok !== false) continue;
    const normalized = normalizeCommand(command.command);
    if (!normalized) continue;
    const key = `${command.agent}\u0000${normalized}`;
    const entry = loops.get(key) ?? { agent: command.agent, command: normalized, count: 0, lastTs: 0 };
    entry.count++;
    entry.lastTs = Math.max(entry.lastTs, command.ts);
    loops.set(key, entry);
  }
  return [...loops.values()].filter((loop) => loop.count >= threshold).sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
}

export function commandStats(commands: Command[], topN = 5): CommandStats {
  const byCommand = new Map<string, NormStat>();
  const errors = new Map<string, number>();
  const durationsByCommand = new Map<string, number[]>();
  let failed = 0;
  for (const command of commands) {
    const normalized = normalizeCommand(command.command);
    if (!normalized) continue;
    const stat = byCommand.get(normalized) ?? { command: normalized, count: 0, failed: 0 };
    stat.count++;
    if (command.ok === false) {
      stat.failed++;
      failed++;
      const line = firstErrorLine(command.error);
      if (line) errors.set(line, (errors.get(line) ?? 0) + 1);
    }
    if (typeof command.duration_ms === "number" && command.duration_ms >= 0) {
      const list = durationsByCommand.get(normalized) ?? [];
      list.push(command.duration_ms);
      durationsByCommand.set(normalized, list);
    }
    byCommand.set(normalized, stat);
  }
  const stats = [...byCommand.values()];
  const timed = commands.filter((c) => typeof c.duration_ms === "number" && c.duration_ms >= 0);
  return {
    total: commands.length,
    failed,
    mostSent: [...stats].sort((a, b) => b.count - a.count || a.command.localeCompare(b.command)).slice(0, topN),
    mostFailed: stats.filter((s) => s.failed > 0).sort((a, b) => b.failed - a.failed || a.command.localeCompare(b.command)).slice(0, topN),
    topErrors: [...errors].map(([error, count]) => ({ error, count })).sort((a, b) => b.count - a.count || a.error.localeCompare(b.error)).slice(0, topN),
    longest: [...timed].sort((a, b) => b.duration_ms! - a.duration_ms!).slice(0, topN)
      .map((c) => ({ agent: c.agent, command: c.command, normalized: normalizeCommand(c.command), duration_ms: c.duration_ms!, ts: c.ts })),
    durations: [...durationsByCommand].map(([command, list]) => {
      list.sort((a, b) => a - b);
      return { command, count: list.length, p50: percentile(list, 0.5), p95: percentile(list, 0.95), max: list[list.length - 1]! };
    }).sort((a, b) => b.p95 - a.p95).slice(0, topN),
    retryLoops: retryLoops(commands),
  };
}
