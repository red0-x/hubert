// Executes validated actions. Window mutations require explicit confirmation in the HTTP handler.
import { tmpdir } from "os";
import { basename } from "path";
import type { Action } from "./brain";
import { collect } from "../state";
import { cancelTurn } from "./sdk";

export type Pane = { session: string; window: string; title: string };
export type Window = { address: string; title: string; class: string; workspace: number };

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

/** Enumerate current mapped clients; do not trust client/model-supplied addresses. */
export function listWindows(): Window[] {
  if (!Bun.which("hyprctl") || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return [];
  const result = run(["hyprctl", "clients", "-j"]);
  if (!result.ok) throw new Error(`could not list Hyprland windows: ${result.err.slice(0, 200)}`);
  const clients: unknown = JSON.parse(result.out);
  if (!Array.isArray(clients)) throw new Error("invalid Hyprland client list");
  return clients.filter((c) => c && c.mapped !== false && typeof c.address === "string" && /^0x[0-9a-f]+$/i.test(c.address))
    .map((c) => ({ address: c.address, title: String(c.title ?? ""), class: String(c.class ?? ""), workspace: Number(c.workspace?.id ?? 0) }));
}

/** Pure command builder: no model-provided dispatcher names or unchecked arguments. */
export function windowCommand(action: unknown, windows: Window[]): string[] {
  const a = action as Record<string, unknown> | null;
  if (!a || (a.type !== "move" && a.type !== "resize")) throw new Error("unsupported window action");
  if (typeof a.address !== "string" || !/^0x[0-9a-f]+$/i.test(a.address) || !windows.some((w) => w.address === a.address))
    throw new Error("window is no longer available");
  const valid = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
  if (a.type === "move") {
    if (!valid(a.x, -10000, 10000) || !valid(a.y, -10000, 10000)) throw new Error("invalid window coordinates");
    return ["hyprctl", "dispatch", "movewindowpixel", `exact ${a.x} ${a.y},address:${a.address}`];
  }
  if (!valid(a.width, 100, 10000) || !valid(a.height, 100, 10000)) throw new Error("invalid window dimensions");
  return ["hyprctl", "dispatch", "resizewindowpixel", `exact ${a.width} ${a.height},address:${a.address}`];
}

export function statusOf(name: string): string {
  const a = collect().agents.find((x) => x.name === name);
  if (!a) throw new Error(`no agent ${name}`);
  return `${a.name} is ${a.state}${a.repo ? ` in ${basename(a.repo)}` : ""}${a.doing ? `. Last: ${a.doing}` : ""}`;
}

export const NEEDS_CONFIRM = new Set<Action["type"]>(["send", "stop", "move", "resize"]);

/** Interrupt a running jcode turn through the harness API. Other agents expose no inbound control. */
export async function stopAgent(name: string): Promise<string> {
  const a = collect().agents.find((x) => x.name === name && (x.state === "working" || x.state === "idle"));
  if (!a) throw new Error(`${name} is not running`);
  if (a.source !== "jcode") throw new Error(`${name} is a ${a.source} agent: Hubert can only interrupt jcode agents (${a.source} has no inbound control API)`);
  await cancelTurn(a.id);
  return `Interrupted ${name}`;
}

export async function execute(a: Action): Promise<string> {
  switch (a.type) {
    case "focus": return focusAgent(a.agent);
    case "send": return sendToAgent(a.agent, a.text);
    case "move":
    case "resize": {
      const argv = windowCommand(a, listWindows());
      const result = run(argv);
      if (!result.ok || result.out !== "ok") throw new Error(`Hyprland refused ${a.type}: ${(result.err || result.out).slice(0, 200)}`);
      return `${a.type === "move" ? "Moved" : "Resized"} window ${a.address}`;
    }
    case "status": return statusOf(a.agent);
    case "stop": return stopAgent(a.agent);
  }
}
