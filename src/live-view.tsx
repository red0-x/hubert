import { useEffect, useState } from "react";
import type { Repo } from "../state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Command = { agent: string; command: string; intent?: string; error?: string; ok: boolean; duration_ms?: number; ts: number };
type EditEvent = { agent: string; root: string; path: string; ts: number };
type Selection = { root: string; path: string } | null;

export function CommandsView() {
  const [commands, setCommands] = useState<Command[]>([]);
  const [error, setError] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);
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
  const visible = failedOnly ? commands.filter(c => !c.ok) : commands;
  return <Card size="sm"><CardHeader><CardTitle>Commands run <span className="text-xs font-normal text-muted-foreground">recent completed calls</span></CardTitle></CardHeader>
    <CardContent>{error && <p role="alert" className="text-destructive">{error}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{commands.length} completed · {commands.filter(c => !c.ok).length} failed</span>
        <Button size="sm" variant={failedOnly ? "ghost" : "secondary"} aria-pressed={!failedOnly} onClick={() => setFailedOnly(false)}>All</Button>
        <Button size="sm" variant={failedOnly ? "secondary" : "ghost"} aria-pressed={failedOnly} onClick={() => setFailedOnly(true)}>Failed</Button>
      </div>
      {visible.length ? <ul className="divide-y">{visible.map((c, i) =>
        <li key={`${c.ts}-${i}`} className="min-w-0 py-2 text-xs">
          <details className="group min-w-0"><summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
            <Badge variant={c.ok ? "secondary" : "destructive"}>{c.ok ? "ok" : "failed"}</Badge>
            <span className="max-w-24 shrink-0 truncate text-muted-foreground" title={c.agent}>{c.agent}</span>
            <span className="min-w-0 flex-1 truncate" title={c.intent ?? c.command}>{c.intent || c.command.split("\n")[0]}</span>
            {c.duration_ms != null && <span className="shrink-0 tabular-nums text-muted-foreground">{c.duration_ms}ms</span>}
            <span aria-hidden="true" className="text-muted-foreground group-open:rotate-90">›</span>
          </summary><pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs"><code>{c.command}</code></pre>
            {c.error && <pre className="mt-1 max-h-32 overflow-auto text-destructive">{c.error}</pre>}
          </details>
        </li>)}</ul> : <p className="text-xs text-muted-foreground">{failedOnly && commands.length ? "No failed commands in this recent sample." : "No completed commands in recent agent journals."}</p>}
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
  const [events, setEvents] = useState<EditEvent[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void fetch("/api/edits").then(r => r.ok ? r.json() as Promise<EditEvent[]> : []).then(data => { if (active) setEvents(data); }).catch(() => {});
      void fetch("/api/commands").then(r => r.ok ? r.json() as Promise<Command[]> : []).then(data => { if (active) setCommands(data); }).catch(() => {});
    };
    refresh(); const timer = setInterval(refresh, 1500);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const active = repos.filter((r) => r.files.length);
  return <Card size="sm"><CardHeader><CardTitle>Change map <span className="text-xs font-normal text-muted-foreground">observed edits · recent journal tails</span></CardTitle></CardHeader>
    <CardContent className="space-y-3">{active.length ? active.map(r => {
      const edits = events.filter(e => e.root === r.root);
      const top = [...r.files].sort((a, b) => edits.filter(e => e.path === b.path).length - edits.filter(e => e.path === a.path).length).slice(0, 5);
      return <section key={r.root} className="rounded-md border p-3" aria-label={`${r.name} relationships`}>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">{r.agents.join(", ") || "Agent unknown"}</span><span aria-hidden="true">→</span>
          <Badge>{r.name}</Badge><span aria-hidden="true">→</span>
          <span>{r.files.length} changed files</span><span className="text-muted-foreground">· {edits.length} observed edit events</span>
        </div>
        <div className="mt-3 max-w-full overflow-x-auto rounded bg-muted/40" aria-label={`${r.name} file graph, scroll horizontally for more`}>
          <svg width="620" height={Math.max(90, top.length * 38 + 20)} role="img" aria-label={`${r.name} connects ${r.agents.length} agents to ${r.files.length} changed files`}>
            {top.map((f, i) => {
              const y = 28 + i * 38;
              const count = edits.filter(e => e.path === f.path).length;
              return <g key={f.path}>
                <line x1="242" y1="45" x2="338" y2={y} className="stroke-border" />
                <circle cx="342" cy={y} r={Math.min(12, 5 + Math.sqrt(count) * 2)} className="fill-primary/70" />
                <text x="363" y={y + 4} className="fill-foreground text-xs">{f.path.length > 27 ? `…${f.path.slice(-26)}` : f.path}{count ? ` · ${count} edits` : ""}</text>
              </g>;
            })}
            <circle cx="240" cy="45" r="10" className="fill-primary" />
            <text x="218" y="49" textAnchor="end" className="fill-foreground text-xs">{r.name}</text>
            <line x1="68" y1="45" x2="230" y2="45" className="stroke-border" />
            <circle cx="64" cy="45" r="7" className="fill-primary/60" />
            <text x="50" y="30" className="fill-foreground text-xs">{r.agents.length} agents</text>
          </svg>
        </div>
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
