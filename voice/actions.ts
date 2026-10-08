// Executes validated actions. Everything here has a real side effect, so callers must confirm anything but focus/status.
import { tmpdir } from "os";
import { basename } from "path";
import type { Action } from "./brain";
import { collect } from "../state";

export type Pane = { session: string; window: string; title: string };

/** tmux pane title "🌐 jcode Snail · +42 -0" -> match by whole word "jcode <Name>". Pure so it can be tested. */
export function findPane(panes: Pane[], shortName: string): Pane | null {
  const re = new RegExp(`\\bjcode ${shortName.replace(/[^a-z0-9]/gi, "")}\\b`, "i");
  return panes.find((p) => re.test(p.title)) ?? null;
}

const run = (argv: string[], cwd?: string) => {
  const r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

function parentPid(pid: number): number | null {
  const r = run(["ps", "-o", "ppid=", "-p", String(pid)]);
  const n = Number(r.out);
  return r.ok && n > 1 ? n : null;
}

/** Bring the terminal showing this agent to the front: tmux pane title -> attached client -> its window (Hyprland). */
export function focusAgent(name: string): string {
  if (!Bun.which("tmux")) throw new Error("focus needs tmux (agent windows are found by tmux pane title)");
  const panes = run(["tmux", "list-panes", "-a", "-F", "#{session_name}|#{window_index}|#{pane_title}"]).out
    .split("\n")
    .map((l) => l.split("|"))
    .filter((p) => p.length >= 3)
    .map(([session, window, ...t]) => ({ session: session!, window: window!, title: t.join("|") }));
  const pane = findPane(panes, name);
  if (!pane) throw new Error(`no tmux pane titled "jcode ${name}"`);
  run(["tmux", "select-window", "-t", `${pane.session}:${pane.window}`]);
  const clients = run(["tmux", "list-clients", "-t", pane.session, "-F", "#{client_pid}"]).out.split("\n").map(Number).filter(Boolean);
  if (!clients.length) throw new Error(`${name} is in tmux session ${pane.session}, which is not open in any terminal window`);
  if (!Bun.which("hyprctl") || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return `${name}: selected tmux window ${pane.session}:${pane.window} (window focus needs Hyprland)`;
  const wins = JSON.parse(run(["hyprctl", "clients", "-j"]).out || "[]") as { pid: number; address: string }[];
  for (let pid: number | null = clients[0]!, i = 0; pid && i < 6; pid = parentPid(pid), i++) {
    const w = wins.find((x) => x.pid === pid);
    if (w) {
      run(["hyprctl", "dispatch", "focuswindow", `address:${w.address}`]);
      return `Focused ${name}`;
    }
  }
  throw new Error(`could not find the terminal window for ${name}`);
}

export function sendToAgent(name: string, text: string): string {
  const a = collect().agents.find((x) => x.name === name && (x.state === "working" || x.state === "idle") && x.source === "jcode");
  if (!a) throw new Error(`${name} is not a running jcode agent`);
  const r = run(["jcode", "--quiet", "--no-update", "--no-selfdev", "transcript", "--session", a.id, "--mode", "send", text], tmpdir());
  if (!r.ok) throw new Error(`jcode transcript failed: ${(r.err || r.out).slice(0, 200)}`);
  return `Sent to ${name}`;
}

const TERMINALS: Record<string, string[]> = { kitty: ["kitty", "--directory"], foot: ["foot", "-D"], alacritty: ["alacritty", "--working-directory"], wezterm: ["wezterm", "start", "--cwd"], ghostty: ["ghostty", "--working-directory="] };

/** Open a new jcode in a terminal in the repo. The prompt is not delivered yet (jcode has no start-with-prompt flag). */
export function openAgent(repoName?: string): string {
  const repo = repoName ? collect().repos.find((r) => r.name === repoName)?.root : undefined;
  if (repoName && !repo) throw new Error(`unknown repo ${repoName}`);
  const dir = repo ?? process.env.HOME ?? tmpdir();
  const term = process.env.HUBERT_TERMINAL?.split(/\s+/) ?? Object.entries(TERMINALS).find(([b]) => Bun.which(b))?.[1];
  if (!term) throw new Error("no terminal found, set HUBERT_TERMINAL");
  const argv = process.env.HUBERT_TERMINAL ? [...term, "jcode"] : term[0] === "ghostty" ? [term[0], `${term[1]}${dir}`, "-e", "jcode"] : [...term, dir, "jcode"];
  Bun.spawn(argv, { cwd: dir, stdio: ["ignore", "ignore", "ignore"] }).unref();
  return `Opened a new jcode in ${basename(dir)}`;
}

export function statusOf(name: string): string {
  const a = collect().agents.find((x) => x.name === name);
  if (!a) throw new Error(`no agent ${name}`);
  return `${a.name} is ${a.state}${a.repo ? ` in ${basename(a.repo)}` : ""}${a.doing ? `. Last: ${a.doing}` : ""}`;
}

export const NEEDS_CONFIRM = new Set<Action["type"]>(["send", "open"]);

export function execute(a: Action): string {
  switch (a.type) {
    case "focus": return focusAgent(a.agent);
    case "send": return sendToAgent(a.agent, a.text);
    case "open": return openAgent(a.repo);
    case "status": return statusOf(a.agent);
  }
}
