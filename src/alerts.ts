import type { Command } from "../live";
import type { Agent, Repo } from "../state";
import { retryLoops } from "../command-stats";

// Pure attention-alert detector. Everything here is deterministic so it can be
// unit tested without the network, timers or a browser. The React hook that wires
// it into the app lives in alerts-view.tsx.

export type AlertKind = "finished" | "retry-loop" | "idle-dirty" | "diff-growing";

export type Alert = {
  /** Stable dedupe key: same condition keeps the same id until it clears. */
  id: string;
  kind: AlertKind;
  severity: "info" | "warn";
  title: string;
  detail: string;
  at: number;
  agent?: string;
  repo?: string;
};

/** One observation of the world, plus the bookkeeping needed for duration signals. */
export type Observed = {
  now: number;
  agents: Agent[];
  repos: Repo[];
  /** agent id -> ms timestamp the current working episode began. */
  workingSince: Record<string, number>;
};

export type AlertThresholds = {
  /** Working at least this long, then going idle counts as "finished". */
  longWorkMs: number;
  /** Idle at least this long with uncommitted changes flags the agent. */
  idleDirtyMs: number;
  /** Failed runs of one normalized command before it is a retry loop. */
  retryCount: number;
  /** Total added+deleted lines before diff growth can matter. */
  diffMinLines: number;
  /** Lines per minute a diff must grow past to be "growing fast". */
  diffRatePerMin: number;
};

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  longWorkMs: 5 * 60_000,
  idleDirtyMs: 10 * 60_000,
  retryCount: 3,
  diffMinLines: 200,
  diffRatePerMin: 120,
};

/** Carry working-episode start times forward: reset when an agent stops working. */
export function nextWorkingSince(prev: Observed | null, agents: Agent[], now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of agents) {
    if (a.state !== "working") continue;
    out[a.id] = prev?.workingSince[a.id] ?? now;
  }
  return out;
}

const churn = (r: Repo) => r.files.reduce((n, f) => n + f.add + f.del, 0);
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/**
 * Alerts that are true for the current observation. Persistent conditions keep a
 * stable id so the caller can suppress repeats; transitions (finished) only appear
 * on the tick where the state actually changed.
 */
export function detectAlerts(
  prev: Observed | null,
  next: Observed,
  commands: Command[],
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
): Alert[] {
  const alerts: Alert[] = [];
  const prevAgents = new Map((prev?.agents ?? []).map((a) => [a.id, a]));

  // 1. Agent finished: was working, now idle, after a long stretch of work.
  for (const a of next.agents) {
    if (a.state !== "idle") continue;
    if (prevAgents.get(a.id)?.state !== "working") continue;
    const since = prev?.workingSince[a.id];
    if (since === undefined) continue;
    const worked = next.now - since;
    if (worked < thresholds.longWorkMs) continue;
    alerts.push({
      id: `finished:${a.id}`,
      kind: "finished",
      severity: "info",
      title: "Agent finished",
      detail: `${a.name} finished after ${minutes(worked)}m of work`,
      at: next.now,
      agent: a.name,
    });
  }

  // 2. Stuck in a retry loop: the same command failing over and over for one agent.
  for (const loop of retryLoops(commands, thresholds.retryCount)) {
    alerts.push({
      id: `retry:${loop.agent}:${loop.command}`,
      kind: "retry-loop",
      severity: "warn",
      title: "Retry loop",
      detail: `${loop.agent} ran ${loop.command} ${loop.count} times, failing`,
      at: loop.lastTs || next.now,
      agent: loop.agent,
    });
  }

  // 3. Idle for a long time while its repo has uncommitted changes.
  for (const a of next.agents) {
    if (a.state !== "idle" || !a.repo) continue;
    const idle = next.now - a.lastActive;
    if (idle < thresholds.idleDirtyMs) continue;
    const repo = next.repos.find((r) => r.root === a.repo);
    if (!repo || !repo.files.length) continue;
    alerts.push({
      id: `idle-dirty:${a.id}`,
      kind: "idle-dirty",
      severity: "warn",
      title: "Idle with changes",
      detail: `${a.name} idle ${minutes(idle)}m with ${repo.files.length} uncommitted file${repo.files.length === 1 ? "" : "s"}`,
      at: a.lastActive,
      agent: a.name,
      repo: repo.name,
    });
  }

  // 4. Large diff growing fast.
  if (prev) {
    const elapsed = next.now - prev.now;
    if (elapsed > 0) {
      const prevChurn = new Map(prev.repos.map((r) => [r.root, churn(r)]));
      for (const repo of next.repos) {
        const before = prevChurn.get(repo.root);
        if (before === undefined) continue;
        const lines = churn(repo);
        if (lines < thresholds.diffMinLines) continue;
        const rate = ((lines - before) / elapsed) * 60_000;
        if (rate < thresholds.diffRatePerMin) continue;
        alerts.push({
          id: `diff:${repo.root}`,
          kind: "diff-growing",
          severity: "warn",
          title: "Diff growing fast",
          detail: `${repo.name} +${Math.round(rate)} lines/min (now ${lines})`,
          at: next.now,
          repo: repo.name,
        });
      }
    }
  }

  return alerts;
}

/**
 * Split alerts into ones the user has not seen yet and the suppression set to carry
 * forward. An id stays suppressed while its condition is present, so a persistent
 * alert only fires once; it drops out and can fire again after the condition clears.
 */
export function freshAlerts(suppressed: Set<string>, alerts: Alert[]): { fresh: Alert[]; suppressed: Set<string> } {
  const current = new Set(alerts.map((a) => a.id));
  const fresh = alerts.filter((a) => !suppressed.has(a.id));
  const keep = new Set([...suppressed].filter((id) => current.has(id)));
  for (const a of fresh) keep.add(a.id);
  return { fresh, suppressed: keep };
}

// ---- Desktop notifications (optional, off by default). Guarded so an unsupported
// webview, denied permission or missing API is a silent no-op. ----

type NotificationCtor = {
  permission: string;
  requestPermission(): Promise<string>;
  new (title: string, options?: { body?: string }): unknown;
};

const notificationCtor = (): NotificationCtor | undefined => {
  if (typeof window === "undefined") return undefined;
  const ctor = (window as unknown as { Notification?: NotificationCtor }).Notification;
  return typeof ctor === "function" ? ctor : undefined;
};

export function notificationsSupported(): boolean {
  return !!notificationCtor();
}

/** Show a desktop notification. Returns false when unsupported or not permitted yet. */
export function notifyAlert(title: string, body: string): boolean {
  const Ctor = notificationCtor();
  if (!Ctor) return false;
  try {
    if (Ctor.permission === "granted") { new Ctor(title, { body }); return true; }
    if (Ctor.permission !== "denied") void Ctor.requestPermission().then((p) => { if (p === "granted") new Ctor(title, { body }); });
  } catch {}
  return false;
}
