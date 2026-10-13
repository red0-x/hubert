import { useEffect, useState } from "react";
import type { Repo } from "../state";
import type { EditEvent } from "../live";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { byHeat, fileStats, hotspots, type FileStat } from "./change-stats";

type Selection = { root: string; path: string };

const ago = (now: number, t: number) => {
  if (!t) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

/** Directory (dimmed) and filename (emphasized), without the separating slash. */
export function splitPath(path: string): [dir: string, file: string] {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i), path.slice(i + 1)];
}

/**
 * Long paths drop their middle: the directory keeps its tail, the filename stays whole.
 * The directory truncates from the left, so its slash is a sibling span (a trailing
 * slash inside an rtl span would flip to the front).
 */
function PathCell({ path }: { path: string }) {
  const [dir, file] = splitPath(path);
  return <span className="flex min-w-0 items-baseline font-mono text-xs">
    {dir && <><span className="min-w-0 truncate text-muted-foreground" style={{ direction: "rtl" }}>{dir}</span><span className="shrink-0 text-muted-foreground">/</span></>}
    <span className="shrink-0">{file}</span>
  </span>;
}

/** Thin bar, one accent, width = heat. Nothing at zero, so quiet files stay quiet. */
function HeatBar({ heat }: { heat: number }) {
  return <span className="block h-[3px] w-full" aria-hidden="true">
    {heat > 0 && <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.max(8, Math.round(heat * 100))}%` }} />}
  </span>;
}

function rowTitle(s: FileStat, now: number) {
  const who = s.agents.length ? s.agents.join(", ") : "no observed edits";
  const churn = s.churn ? ` · +/- ${s.churn}` : "";
  return `${s.edits} edit${s.edits === 1 ? "" : "s"} by ${who} · last ${ago(now, s.lastTs)}${churn}`;
}

function FileRows({ root, stats, now, selected, onSelect }: { root: string; stats: FileStat[]; now: number; selected: Selection | null; onSelect: (s: Selection) => void }) {
  const shared = new Set(hotspots(stats).map((s) => s.path));
  const rows = [...stats].sort(byHeat);
  const shown = rows.slice(0, 12);
  return <>
    <ul className="divide-y divide-border/70">
      {shown.map((s) => {
        const isSelected = selected?.root === root && selected.path === s.path;
        return <li key={s.path}>
          <button type="button" onClick={() => onSelect({ root, path: s.path })} title={rowTitle(s, now)}
            aria-current={isSelected ? "true" : undefined}
            className={cn("grid w-full grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-3 border-l-2 border-transparent px-2 py-1 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
              shared.has(s.path) && "border-primary/50", isSelected && "bg-muted")}>
            <HeatBar heat={s.heat} />
            <PathCell path={s.path} />
            <span className="text-right text-xs text-muted-foreground tabular-nums">{s.edits || ""}</span>
          </button>
        </li>;
      })}
    </ul>
    {rows.length > shown.length && <p className="px-2 pt-1 text-xs text-muted-foreground">{rows.length - shown.length} quieter files not shown</p>}
  </>;
}

export function ChangeMap({ repos, onSelect }: { repos: Repo[]; onSelect: (s: Selection) => void }) {
  const [events, setEvents] = useState<EditEvent[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let active = true;
    const refresh = () => {
      setNow(Date.now());
      void fetch("/api/edits").then(r => r.ok ? r.json() as Promise<EditEvent[]> : []).then(data => { if (active) setEvents(data); }).catch(() => {});
    };
    refresh(); const timer = setInterval(refresh, 1500);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const pick = (s: Selection) => { setSelected(s); onSelect(s); };
  const active = repos.filter((r) => r.files.length);
  return <Card size="sm"><CardHeader><CardTitle>Change map <span className="text-xs font-normal text-muted-foreground">hottest files first · bar = recent edits</span></CardTitle></CardHeader>
    <CardContent className="space-y-4">{active.length ? active.map((r, i) => {
      const edits = events.filter(e => e.root === r.root);
      const stats = fileStats(r.files, edits, now);
      return <section key={r.root} className={cn(i > 0 && "border-t pt-4")} aria-label={`${r.name} change map`}>
        <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-2 pb-2">
          <h3 className="text-xs font-medium">{r.name}</h3>
          {r.branch && <span className="text-xs text-muted-foreground">{r.branch}</span>}
          {r.agents.map(a => <Badge key={a} variant="outline" className="font-normal text-muted-foreground">{a}</Badge>)}
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">{r.files.length} file{r.files.length === 1 ? "" : "s"} · {edits.length} edit{edits.length === 1 ? "" : "s"}</span>
        </header>
        <FileRows root={r.root} stats={stats} now={now} selected={selected} onSelect={pick} />
      </section>;
    }) : <p className="text-xs text-muted-foreground">No changed files to map.</p>}</CardContent>
  </Card>;
}
