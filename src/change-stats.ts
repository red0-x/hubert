import type { EditEvent } from "../live";
import type { FileChange } from "../state";

export type FileStat = {
  path: string;
  status: string;
  edits: number;
  agents: string[];
  lastTs: number;
  churn: number; // added + removed lines from git
  heat: number; // 0..1, recency-weighted change frequency
};

/**
 * Per-file change statistics for the change map: how often each changed file was edited,
 * by which agents, its git churn, and a heat score blending recency with frequency.
 */
export function fileStats(files: FileChange[], events: EditEvent[], now: number, windowMs = 30 * 60_000): FileStat[] {
  const byPath = new Map<string, EditEvent[]>();
  for (const e of events) {
    const list = byPath.get(e.path);
    if (list) list.push(e); else byPath.set(e.path, [e]);
  }
  const maxEdits = Math.max(1, ...[...byPath.values()].map((list) => list.length));
  return files.map((f) => {
    const list = byPath.get(f.path) ?? [];
    const lastTs = list.reduce((m, e) => Math.max(m, e.ts), 0);
    const agents = [...new Set(list.map((e) => e.agent))];
    const recency = lastTs ? Math.max(0, 1 - (now - lastTs) / windowMs) : 0;
    const frequency = list.length / maxEdits;
    return {
      path: f.path, status: f.status, edits: list.length, agents, lastTs,
      churn: f.add + f.del,
      heat: Math.round((0.6 * recency + 0.4 * frequency) * 100) / 100,
    };
  });
}

/** Files touched by more than one agent recently: conflict risk worth flagging. */
export function hotspots(stats: FileStat[]): FileStat[] {
  return stats.filter((s) => s.agents.length > 1);
}

/** Hottest first, then by churn, so the change map surface leads with what matters. */
export function byHeat(a: FileStat, b: FileStat): number {
  return b.heat - a.heat || b.edits - a.edits || b.churn - a.churn || a.path.localeCompare(b.path);
}
