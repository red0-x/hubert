import { useEffect, useState } from "react";
import type { Repo } from "../state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Command = { agent: string; command: string; ok: boolean; duration_ms?: number; ts: number };
type Selection = { root: string; path: string } | null;

export function CommandsView() {
  const [commands, setCommands] = useState<Command[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () => fetch("/api/commands")
      .then((r) => { if (!r.ok) throw new Error("Commands unavailable"); return r.json() as Promise<Command[]>; })
      .then((data) => { if (active) { setCommands(data); setError(""); } })
      .catch(() => { if (active) setError("Commands unavailable"); });
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => { active = false; clearInterval(timer); };
  }, []);
  return <Card size="sm"><CardHeader><CardTitle>Commands run <span className="text-xs font-normal text-muted-foreground">live</span></CardTitle></CardHeader>
    <CardContent>{error && <p role="alert" className="text-destructive">{error}</p>}
      {commands.length ? <ul className="divide-y">{commands.map((c, i) =>
        <li key={`${c.ts}-${i}`} className="flex items-start gap-2 py-2 text-xs">
          <Badge variant={c.ok ? "secondary" : "destructive"}>{c.ok ? "ok" : "failed"}</Badge>
          <span className="shrink-0 text-muted-foreground">{c.agent}</span>
          <code className="min-w-0 flex-1 break-all whitespace-pre-wrap">{c.command}</code>
          {c.duration_ms != null && <span className="shrink-0 tabular-nums text-muted-foreground">{c.duration_ms}ms</span>}
        </li>)}</ul> : <p className="text-xs text-muted-foreground">No completed commands in recent agent journals.</p>}
    </CardContent></Card>;
}

export function DiffView({ repos, selected, onSelect }: { repos: Repo[]; selected: Selection; onSelect: (s: Selection) => void }) {
  const [diff, setDiff] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!selected) { setDiff(""); return; }
    let active = true;
    const refresh = () => fetch(`/api/diff?root=${encodeURIComponent(selected.root)}&file=${encodeURIComponent(selected.path)}`)
      .then((r) => { if (!r.ok) throw new Error("Diff unavailable"); return r.text(); })
      .then((text) => { if (active) { setDiff(text); setError(""); } })
      .catch(() => { if (active) setError("Diff unavailable"); });
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [selected?.root, selected?.path]);
  return <div className="grid min-h-0 gap-3 md:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]">
    <Card size="sm"><CardHeader><CardTitle>Changed files</CardTitle></CardHeader><CardContent>
      {repos.map((r) => <div key={r.root} className="mb-3"><p className="mb-1 text-xs font-semibold">{r.name}</p>
        {r.files.map((f) => <Button key={f.path} variant={selected?.root === r.root && selected.path === f.path ? "secondary" : "ghost"}
          size="sm" className="h-auto w-full justify-start text-left font-mono text-xs whitespace-normal break-all"
          onClick={() => onSelect({ root: r.root, path: f.path })}>{f.status} {f.path}</Button>)}</div>)}
      {!repos.some((r) => r.files.length) && <p className="text-xs text-muted-foreground">No changed files.</p>}
    </CardContent></Card>
    <Card size="sm" className="min-w-0"><CardHeader><CardTitle>{selected?.path ?? "Select a file"} <span className="text-xs font-normal text-muted-foreground">live diff vs HEAD</span></CardTitle></CardHeader>
      <CardContent>{error && <p role="alert" className="text-destructive">{error}</p>}
        <pre className="max-h-[70vh] overflow-auto rounded-md bg-muted p-3 text-xs"><code>{selected ? diff || "No textual diff" : "Choose a changed file to inspect."}</code></pre>
      </CardContent></Card>
  </div>;
}

export function ChangeMap({ repos, onSelect }: { repos: Repo[]; onSelect: (s: NonNullable<Selection>) => void }) {
  const active = repos.filter((r) => r.files.length);
  // ponytail: fixed columns stay readable for small working trees; use a force layout if graphs grow dense.
  const height = Math.max(260, active.reduce((n, r) => n + Math.max(130, r.files.length * 32), 0));
  let offset = 0;
  return <Card size="sm"><CardHeader><CardTitle>Change map <span className="text-xs font-normal text-muted-foreground">repos ↔ changed files</span></CardTitle></CardHeader>
    <CardContent>{active.length ? <svg className="w-full rounded-md bg-muted/40" viewBox={`0 0 840 ${height}`} role="img" aria-label="Connected map of repositories and changed files">
      {active.map((r) => {
        const span = Math.max(130, r.files.length * 32);
        const y = offset + span / 2;
        offset += span;
        return <g key={r.root}>
          <circle cx="170" cy={y} r="9" className="fill-primary" />
          <text x="150" y={y - 16} textAnchor="end" className="fill-foreground text-xs">{r.name}</text>
          {r.files.map((f, i) => {
            const fy = y + (i - (r.files.length - 1) / 2) * 32;
            return <g key={f.path}>
              <line x1="179" y1={y} x2="504" y2={fy} className="stroke-border" />
              <g role="button" tabIndex={0} aria-label={`Show diff for ${f.path}`} className="cursor-pointer focus:outline-primary" onClick={() => onSelect({ root: r.root, path: f.path })}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect({ root: r.root, path: f.path }); } }}>
                <circle cx="510" cy={fy} r="6" className="fill-primary/70" />
                <text x="524" y={fy + 4} className="fill-foreground text-xs">{f.path.length > 42 ? `…${f.path.slice(-41)}` : f.path}</text>
                <title>{f.path}</title>
              </g>
            </g>;
          })}
        </g>;
      })}
    </svg> : <p className="text-xs text-muted-foreground">No changed files to map.</p>}</CardContent>
  </Card>;
}
