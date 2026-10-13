import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agent, Repo } from "../state";
import type { Command, EditEvent } from "../live";
import { byHeat, fileStats, hotspots } from "./change-stats";
import { DiffCode, DiffHeader, diffInfo } from "./live-view";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Selection = { root: string; path: string } | null;

/** The parts of /api/command-stats the dashboard pane uses. */
type Stats = { total: number; failed: number; retryLoops: { agent: string; command: string; count: number; lastTs: number }[] };

/** One line in the merged activity feed: a command, a file edit or an agent state change. */
export type FeedItem = { ts: number; agent: string; kind: "command" | "edit" | "state"; text: string; ok?: boolean; root?: string; path?: string };

/** Newest first, capped. Pure so feed ordering is testable without a DOM. */
export function mergeFeed(items: FeedItem[], limit = 150): FeedItem[] {
  return [...items].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/** Per repo: the hottest changed files plus how many were touched by more than one agent. */
export function repoSummaries(repos: Repo[], edits: EditEvent[], now: number, perRepo = 6) {
  return repos.filter((r) => r.files.length).map((repo) => {
    const stats = fileStats(repo.files, edits.filter((e) => e.root === repo.root), now);
    return { repo, files: [...stats].sort(byHeat).slice(0, perRepo), shared: hotspots(stats).length };
  });
}

const ago = (now: number, t: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const tildify = (p: string | null) => (p ?? "").replace(/^\/(home|Users)\/[^/]+/, "~");

const DOT: Record<Agent["state"], string> = {
  working: "bg-primary animate-pulse motion-reduce:animate-none",
  idle: "bg-muted-foreground",
  closed: "bg-border",
  crashed: "bg-destructive",
};

/** Blue (cold) to red (hot) fill for a 0..1 heat score, matching the change map's scale. */
function heatColor(heat: number): string {
  const hue = Math.round(220 - Math.max(0, Math.min(1, heat)) * 220);
  return `hsl(${hue} 75% 55%)`;
}

/** Small recency heat bar. */
function HeatBar({ heat }: { heat: number }) {
  return <span className="inline-block h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden="true">
    <span className="block h-full rounded-full" style={{ width: `${Math.round(heat * 100)}%`, background: heatColor(heat) }} />
  </span>;
}

const KIND_LABEL = { command: "cmd", edit: "edit", state: "state" } as const;

/** One dashboard pane: sized by the grid on wide screens, scrolls on its own. */
function Pane({ title, hint, className, children }: { title: string; hint?: ReactNode; className?: string; children: ReactNode }) {
  return <Card size="sm" className={cn("min-h-[16rem] lg:min-h-0", className)}>
    <CardHeader className="shrink-0">
      <CardTitle>{title}{hint && <span className="ml-2 text-xs font-normal text-muted-foreground">{hint}</span>}</CardTitle>
    </CardHeader>
    <CardContent className="min-h-0 flex-1 overflow-auto">{children}</CardContent>
  </Card>;
}

function AgentsPane({ agents, now, showClosed, className }: { agents: Agent[]; now: number; showClosed: boolean; className?: string }) {
  const shown = useMemo(() => agents
    .filter((a) => showClosed || a.state === "working" || a.state === "idle")
    .sort((a, b) => Number(b.state === "working") - Number(a.state === "working") || b.lastActive - a.lastActive), [agents, showClosed]);
  const working = agents.filter((a) => a.state === "working").length;
  return <Pane title="Agents" hint={`${working} working · ${agents.length} seen`} className={className}>
    {shown.length ? <ul className="divide-y">
      {shown.map((a) => <li key={a.id} className={cn("py-1.5", (a.state === "closed" || a.state === "crashed") && "opacity-60")}>
        <div className="flex items-center gap-2 text-xs">
          <span className={cn("size-2 shrink-0 rounded-full", DOT[a.state])} aria-label={a.state} />
          <span className="truncate font-medium">{a.name}</span>
          <span className="text-muted-foreground">{a.state}</span>
          <Badge variant="outline">{a.source}</Badge>
          {a.state === "crashed" && <Badge variant="destructive">crashed</Badge>}
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{ago(now, a.lastActive)}</span>
        </div>
        <div className="truncate pl-4 text-xs text-muted-foreground">{tildify(a.repo ?? a.cwd)}</div>
        {a.doing && <div className="truncate pl-4 font-mono text-xs text-muted-foreground" title={a.doing}>{a.doing}</div>}
      </li>)}
    </ul> : <p className="text-xs text-muted-foreground">No agents running.</p>}
  </Pane>;
}

function FeedPane({ feed, now, onSelect, className }: { feed: FeedItem[]; now: number; onSelect: (s: Selection) => void; className?: string }) {
  return <Pane title="Live activity" hint="commands, edits, state changes" className={className}>
    {feed.length ? <ol className="flex flex-col gap-1">
      {feed.map((f, i) => <li key={`${f.ts}-${i}`} className="flex items-baseline gap-2 text-xs">
        <span className="w-8 shrink-0 tabular-nums text-muted-foreground">{ago(now, f.ts)}</span>
        <Badge variant={f.kind === "command" && f.ok === false ? "destructive" : f.kind === "command" ? "secondary" : "outline"}>{KIND_LABEL[f.kind]}</Badge>
        <span className="w-24 shrink-0 truncate text-muted-foreground" title={f.agent}>{f.agent}</span>
        {f.kind === "edit" && f.root && f.path
          ? <button className="min-w-0 truncate text-left font-mono hover:underline" title={f.text} onClick={() => onSelect({ root: f.root!, path: f.path! })}>{f.text}</button>
          : <span className="min-w-0 truncate" title={f.text}>{f.text}</span>}
      </li>)}
    </ol> : <p className="text-xs text-muted-foreground">No recent activity in agent journals.</p>}
  </Pane>;
}

function ChangeSummaryPane({ repos, edits, now, onSelect, className }: { repos: Repo[]; edits: EditEvent[]; now: number; onSelect: (s: Selection) => void; className?: string }) {
  const summaries = useMemo(() => repoSummaries(repos, edits, now), [repos, edits, now]);
  return <Pane title="Change map" hint="hottest files per repo" className={className}>
    {summaries.length ? summaries.map(({ repo, files, shared }) => <section key={repo.root} className="mb-3 last:mb-0">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="truncate font-medium">{repo.name}</span>
        <Badge variant="outline">{repo.files.length} changed</Badge>
        {shared > 0 && <Badge variant="destructive">{shared} shared</Badge>}
        <span className="truncate text-muted-foreground">{repo.agents.join(", ")}</span>
      </div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {files.map((f) => <li key={f.path} className="flex items-center gap-2 text-xs">
          <button className="min-w-0 flex-1 truncate text-left font-mono hover:underline" title={f.path} onClick={() => onSelect({ root: repo.root, path: f.path })}>{f.path}</button>
          <span className="shrink-0 tabular-nums text-muted-foreground">{f.edits ? `${f.edits} edits` : "no edits"}</span>
          {f.churn > 0 && <span className="shrink-0 tabular-nums text-muted-foreground">{f.churn}</span>}
          <HeatBar heat={f.heat} />
        </li>)}
      </ul>
    </section>) : <p className="text-xs text-muted-foreground">No changed files to summarise.</p>}
  </Pane>;
}

function CommandsPane({ commands, stats, className }: { commands: Command[]; stats: Stats | null; className?: string }) {
  const failures = commands.filter((c) => c.ok === false).length;
  const loops = stats?.retryLoops ?? [];
  return <Pane title="Commands" hint="recent completed calls" className={className}>
    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{commands.length} recent · {failures} failed</span>
      {loops.map((l) => <Badge key={`${l.agent}-${l.command}`} variant="destructive" title={`${l.command} failed ${l.count} times for ${l.agent}`}>{l.agent} {l.command} ×{l.count}</Badge>)}
    </div>
    {commands.length ? <ul className="divide-y">
      {commands.slice(0, 15).map((c, i) => <li key={`${c.ts}-${i}`} className="flex items-center gap-2 py-1 text-xs">
        <Badge variant={c.ok === false ? "destructive" : c.ok === true ? "secondary" : "outline"}>{c.ok === false ? "fail" : c.ok === true ? "ok" : "?"}</Badge>
        <span className="w-20 shrink-0 truncate text-muted-foreground" title={c.agent}>{c.agent}</span>
        <span className="min-w-0 flex-1 truncate" title={c.intent || c.command}>{c.intent || c.command.split("\n")[0]}</span>
        {c.duration_ms != null && <span className="shrink-0 tabular-nums text-muted-foreground">{c.duration_ms}ms</span>}
      </li>)}
    </ul> : <p className="text-xs text-muted-foreground">No completed commands in recent agent journals.</p>}
  </Pane>;
}

function DiffPane({ file, edits, now, className }: { file: { root: string; path: string } | null; edits: EditEvent[]; now: number; className?: string }) {
  const [diff, setDiff] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!file) { setDiff(""); setError(""); return; }
    let active = true;
    const refresh = () => fetch(`/api/diff?root=${encodeURIComponent(file.root)}&file=${encodeURIComponent(file.path)}`)
      .then((r) => { if (!r.ok) throw new Error("Diff unavailable"); return r.text(); })
      .then((text) => { if (active) { setDiff(text); setError(""); } })
      .catch(() => { if (active) setError("Diff unavailable"); });
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [file?.root, file?.path]);
  return <Pane title="Live diff" className={className}>
    {file
      ? <>
        <DiffHeader info={diffInfo(file.path, diff, edits, file.root)} now={now} right="live vs HEAD" />
        {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
        <div className="mt-2"><DiffCode raw={diff} /></div>
      </>
      : <p className="text-xs text-muted-foreground">Choose a changed file to inspect.</p>}
  </Pane>;
}

/**
 * Central overview: agents, merged activity, change map summary, commands and a live diff
 * filled into one viewport grid, each pane scrolling on its own.
 * Reuses /api/state (agents), /api/commands, /api/edits, /api/command-stats and /api/diff.
 */
export function Dashboard({ agents, repos, now, showClosed, selected, onSelect }: {
  agents: Agent[]; repos: Repo[]; now: number; showClosed: boolean; selected: Selection; onSelect: (s: Selection) => void;
}) {
  const [commands, setCommands] = useState<Command[]>([]);
  const [edits, setEdits] = useState<EditEvent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [stateEvents, setStateEvents] = useState<FeedItem[]>([]);
  const prevStates = useRef(new Map<string, Agent["state"]>());

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void fetch("/api/commands").then((r) => (r.ok ? r.json() as Promise<Command[]> : [])).then((d) => { if (active) setCommands(d); }).catch(() => {});
      void fetch("/api/edits").then((r) => (r.ok ? r.json() as Promise<EditEvent[]> : [])).then((d) => { if (active) setEdits(d); }).catch(() => {});
      void fetch("/api/command-stats").then((r) => (r.ok ? r.json() as Promise<Stats> : null)).then((d) => { if (active && d) setStats(d); }).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => { active = false; clearInterval(timer); };
  }, []);

  // There is no server-side history of agent state, so transitions are noticed as the polls arrive.
  useEffect(() => {
    const changes: FeedItem[] = [];
    for (const a of agents) {
      const before = prevStates.current.get(a.id);
      if (before !== undefined && before !== a.state) changes.push({ ts: Date.now(), agent: a.name, kind: "state", text: `is now ${a.state}` });
      prevStates.current.set(a.id, a.state);
    }
    if (changes.length) setStateEvents((prev) => [...changes, ...prev].slice(0, 60));
  }, [agents]);

  const feed = useMemo(() => mergeFeed([
    ...commands.map((c) => ({ ts: c.ts, agent: c.agent, kind: "command" as const, ok: c.ok, text: (c.intent || c.command.split("\n")[0] || c.command).trim() })),
    ...edits.map((e) => ({ ts: e.ts, agent: e.agent, kind: "edit" as const, root: e.root, path: e.path, text: e.path })),
    ...stateEvents,
  ]), [commands, edits, stateEvents]);

  const file = selected ?? (() => {
    for (const r of repos) { const f = r.files[0]; if (f) return { root: r.root, path: f.path }; }
    return null;
  })();

  // 3 columns on lg (agents | activity | map/commands/diff stacked), 4 columns on 2xl (diff gets its own column).
  return <div className="grid min-h-0 flex-1 gap-3 overflow-auto p-3 lg:h-full lg:overflow-hidden lg:grid-cols-3 lg:grid-rows-3 2xl:grid-cols-4 2xl:grid-rows-2">
    <AgentsPane agents={agents} now={now} showClosed={showClosed} className="lg:col-start-1 lg:row-span-3 2xl:col-start-1 2xl:row-span-2" />
    <FeedPane feed={feed} now={now} onSelect={onSelect} className="lg:col-start-2 lg:row-start-1 lg:row-span-3 2xl:col-start-2 2xl:row-start-1 2xl:row-span-2" />
    <ChangeSummaryPane repos={repos} edits={edits} now={now} onSelect={onSelect} className="lg:col-start-3 lg:row-start-1 2xl:col-start-3 2xl:row-start-1" />
    <CommandsPane commands={commands} stats={stats} className="lg:col-start-3 lg:row-start-2 2xl:col-start-3 2xl:row-start-2" />
    <DiffPane file={file} edits={edits} now={now} className="lg:col-start-3 lg:row-start-3 2xl:col-start-4 2xl:row-start-1 2xl:row-span-2" />
  </div>;
}
