import { useEffect, useState } from "react";
import type { Repo } from "../state";
import type { Command, EditEvent } from "../live";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { byHeat, fileStats, hotspots, type FileStat } from "./change-stats";

type Selection = NonNullable<{ root: string; path: string }>;

const ago = (now: number, t: number) => {
  if (!t) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

/** Blue (cold) to red (hot) fill for a 0..1 heat score. */
export function heatColor(heat: number): string {
  const hue = Math.round(220 - Math.max(0, Math.min(1, heat)) * 220);
  return `hsl(${hue} 75% 55%)`;
}

function HeatBar({ heat }: { heat: number }) {
  return <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-muted align-middle" aria-hidden="true">
    <span className="block h-full rounded-full" style={{ width: `${Math.round(heat * 100)}%`, background: heatColor(heat) }} />
  </span>;
}

function FrequencyTable({ root, stats, now, onSelect }: { root: string; stats: FileStat[]; now: number; onSelect: (s: Selection) => void }) {
  const hot = new Set(hotspots(stats).map((s) => s.path));
  if (!stats.length) return null;
  return <table className="mt-3 w-full border-collapse text-xs">
    <caption className="sr-only">Change frequency for {root}</caption>
    <thead><tr className="text-left text-muted-foreground">
      <th scope="col" className="py-1 font-normal">File</th>
      <th scope="col" className="py-1 text-right font-normal">Edits</th>
      <th scope="col" className="py-1 text-right font-normal">+/-</th>
      <th scope="col" className="py-1 text-right font-normal">Last</th>
      <th scope="col" className="py-1 pl-2 font-normal">Heat</th>
    </tr></thead>
    <tbody>
      {[...stats].sort(byHeat).slice(0, 12).map((s) => <tr key={s.path} className="border-t">
        <td className="max-w-0 py-1">
          <button className="block w-full truncate text-left font-mono hover:underline" title={s.path}
            onClick={() => onSelect({ root, path: s.path })}>{s.path}</button>
          {hot.has(s.path) && <Badge variant="destructive" className="mt-0.5">hotspot</Badge>}
        </td>
        <td className="py-1 text-right tabular-nums">{s.edits || ""}</td>
        <td className="py-1 text-right tabular-nums text-muted-foreground">{s.churn ? s.churn : ""}</td>
        <td className="py-1 text-right tabular-nums text-muted-foreground">{ago(now, s.lastTs)}</td>
        <td className="py-1 pl-2"><HeatBar heat={s.heat} /></td>
      </tr>)}
    </tbody>
  </table>;
}

export function ChangeMap({ repos, onSelect }: { repos: Repo[]; onSelect: (s: Selection) => void }) {
  const [events, setEvents] = useState<EditEvent[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let active = true;
    const refresh = () => {
      setNow(Date.now());
      void fetch("/api/edits").then(r => r.ok ? r.json() as Promise<EditEvent[]> : []).then(data => { if (active) setEvents(data); }).catch(() => {});
      void fetch("/api/commands").then(r => r.ok ? r.json() as Promise<Command[]> : []).then(data => { if (active) setCommands(data); }).catch(() => {});
    };
    refresh(); const timer = setInterval(refresh, 1500);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const active = repos.filter((r) => r.files.length);
  return <Card size="sm"><CardHeader><CardTitle>Change map <span className="text-xs font-normal text-muted-foreground">observed edits · size = edit count · color = recency</span></CardTitle></CardHeader>
    <CardContent className="space-y-3">{active.length ? active.map(r => {
      const edits = events.filter(e => e.root === r.root);
      const stats = fileStats(r.files, edits, now);
      const top = [...stats].sort(byHeat).slice(0, 6);
      const hot = hotspots(stats);
      return <section key={r.root} className="rounded-md border p-3" aria-label={`${r.name} relationships`}>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">{r.agents.join(", ") || "Agent unknown"}</span><span aria-hidden="true">→</span>
          <Badge>{r.name}</Badge><span aria-hidden="true">→</span>
          <span>{r.files.length} changed files</span><span className="text-muted-foreground">· {edits.length} observed edit events</span>
          {hot.length > 0 && <Badge variant="destructive">{hot.length} hotspot{hot.length > 1 ? "s" : ""}</Badge>}
        </div>
        <div className="mt-3 max-w-full overflow-x-auto rounded bg-muted/40" aria-label={`${r.name} file graph, scroll horizontally for more`}>
          <svg width="620" height={Math.max(90, top.length * 38 + 20)} role="img" aria-label={`${r.name} connects ${r.agents.length} agents to ${r.files.length} changed files`}>
            {top.map((f, i) => {
              const y = 28 + i * 38;
              const r2 = Math.min(13, 5 + Math.sqrt(f.edits) * 2.4);
              return <g key={f.path} className="cursor-pointer" role="button" tabIndex={0}
                aria-label={`Show diff for ${f.path}, ${f.edits} edits`}
                onClick={() => onSelect({ root: r.root, path: f.path })}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect({ root: r.root, path: f.path }); } }}>
                <line x1="242" y1="45" x2="338" y2={y} className="stroke-border" />
                <circle cx="342" cy={y} r={r2} fill={heatColor(f.heat)} />
                <text x="363" y={y + 4} className="fill-foreground text-xs hover:underline">{f.path.length > 27 ? `…${f.path.slice(-26)}` : f.path}{f.edits ? ` · ${f.edits} edits` : ""}</text>
              </g>;
            })}
            <circle cx="240" cy="45" r="10" className="fill-primary" />
            <text x="218" y="49" textAnchor="end" className="fill-foreground text-xs">{r.name}</text>
            <line x1="68" y1="45" x2="230" y2="45" className="stroke-border" />
            <circle cx="64" cy="45" r="7" className="fill-primary/60" />
            <text x="50" y="30" className="fill-foreground text-xs">{r.agents.length} agents</text>
          </svg>
        </div>
        <FrequencyTable root={r.root} stats={stats} now={now} onSelect={onSelect} />
        <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">All relationships and commands</summary>
          <ul className="mt-2 space-y-1">
            {r.files.map(f => <li key={f.path}><Button size="sm" variant="ghost" className="h-auto max-w-full justify-start font-mono text-xs" onClick={() => onSelect({ root: r.root, path: f.path })}>{f.path}</Button>
              {edits.filter(e => e.path === f.path).length > 0 && <span className="text-muted-foreground">{edits.filter(e => e.path === f.path).length} edits by {[...new Set(edits.filter(e => e.path === f.path).map(e => e.agent))].join(", ")}</span>}</li>)}
            {r.agents.flatMap(agent => commands.filter(c => c.agent === agent).slice(0, 5).map((c, i) => <li key={`${agent}-${c.ts}-${i}`} className="truncate text-muted-foreground" title={c.command}>{agent} → {c.intent || c.command.split("\n")[0]}</li>))}
          </ul>
        </details>
      </section>;
    }) : <p className="text-xs text-muted-foreground">No changed files to map.</p>}</CardContent>
  </Card>;
}
