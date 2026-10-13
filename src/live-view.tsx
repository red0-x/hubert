import { Fragment, useEffect, useState } from "react";
import type { Repo } from "../state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { groupHunks, inlineHighlights, parseDiff, splitRows, type DiffHunk, type DiffLine, type Segment } from "./diff";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export { ChangeMap } from "./change-map";

type Command = { agent: string; command: string; intent?: string; error?: string; ok?: boolean; duration_ms?: number; ts: number };
type NormStat = { command: string; count: number; failed: number };
type CommandStatsData = {
  total: number; failed: number;
  mostSent: NormStat[]; mostFailed: NormStat[];
  topErrors: { error: string; count: number }[];
  longest: { agent: string; command: string; normalized: string; duration_ms: number; ts: number }[];
  durations: { command: string; count: number; p50: number; p95: number; max: number }[];
  retryLoops: { agent: string; command: string; count: number; lastTs: number }[];
};
type EditEvent = { agent: string; root: string; path: string; ts: number };
type Selection = { root: string; path: string } | null;

export function CommandsView({ onlyFailed }: { onlyFailed?: boolean } = {}) {
  const [commands, setCommands] = useState<Command[]>([]);
  const [stats, setStats] = useState<CommandStatsData | null>(null);
  const [error, setError] = useState("");
  const [failedOnly, setFailedOnly] = useState(!!onlyFailed);
  const [tab, setTab] = useState<"live" | "stats">("live");
  // Voice ("show failing commands") opens this panel already filtered; the tabs still work normally.
  useEffect(() => { if (onlyFailed !== undefined) setFailedOnly(onlyFailed); }, [onlyFailed]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void fetch("/api/commands")
        .then((r) => { if (!r.ok) throw new Error("Commands unavailable"); return r.json() as Promise<Command[]>; })
        .then((data) => { if (active) { setCommands(data); setError(""); } })
        .catch(() => { if (active) setError("Commands unavailable"); });
      void fetch("/api/command-stats")
        .then((r) => (r.ok ? r.json() as Promise<CommandStatsData> : null))
        .then((data) => { if (active && data) setStats(data); })
        .catch(() => {});
    };
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const visible = failedOnly ? commands.filter(c => c.ok === false) : commands;
  return <Card size="sm"><CardHeader><CardTitle>Commands run <span className="text-xs font-normal text-muted-foreground">recent completed calls</span></CardTitle></CardHeader>
    <CardContent>{error && <p role="alert" className="text-destructive">{error}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Button size="sm" variant={tab === "live" ? "secondary" : "ghost"} aria-pressed={tab === "live"} onClick={() => setTab("live")}>Live</Button>
        <Button size="sm" variant={tab === "stats" ? "secondary" : "ghost"} aria-pressed={tab === "stats"} onClick={() => setTab("stats")}>Stats</Button>
        {tab === "live" && <>
          <span>{commands.length} completed · {commands.filter(c => c.ok === false).length} failed</span>
          <Button size="sm" variant={failedOnly ? "ghost" : "secondary"} aria-pressed={!failedOnly} onClick={() => setFailedOnly(false)}>All</Button>
          <Button size="sm" variant={failedOnly ? "secondary" : "ghost"} aria-pressed={failedOnly} onClick={() => setFailedOnly(true)}>Failed</Button>
        </>}
        {tab === "stats" && stats && stats.retryLoops.length > 0 && <Badge variant="destructive">{stats.retryLoops.length} retry loop{stats.retryLoops.length === 1 ? "" : "s"}</Badge>}
      </div>
      {tab === "live"
        ? (visible.length ? <ul className="divide-y">{visible.map((c, i) =>
          <li key={`${c.ts}-${i}`} className="min-w-0 py-2 text-xs">
            <details className="group min-w-0"><summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
              <Badge variant={c.ok === false ? "destructive" : c.ok === true ? "secondary" : "outline"}>{c.ok === false ? "failed" : c.ok === true ? "ok" : "?"}</Badge>
              <span className="max-w-24 shrink-0 truncate text-muted-foreground" title={c.agent}>{c.agent}</span>
              <span className="min-w-0 flex-1 truncate" title={c.intent ?? c.command}>{c.intent || c.command.split("\n")[0]}</span>
              {c.duration_ms != null && <span className="shrink-0 tabular-nums text-muted-foreground">{c.duration_ms}ms</span>}
              <span aria-hidden="true" className="text-muted-foreground group-open:rotate-90">›</span>
            </summary><pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs"><code>{c.command}</code></pre>
              {c.error && <pre className="mt-1 max-h-32 overflow-auto text-destructive">{c.error}</pre>}
            </details>
          </li>)}</ul> : <p className="text-xs text-muted-foreground">{failedOnly && commands.length ? "No failed commands in this recent sample." : "No completed commands in recent agent journals."}</p>)
        : stats ? <CommandStatsPanel stats={stats} /> : <p className="text-xs text-muted-foreground">Loading stats…</p>}
    </CardContent></Card>;
}

function StatList({ title, rows, empty }: { title: string; rows: { key: string; main: string; meta?: string }[]; empty: string }) {
  return <section className="min-w-0">
    <h3 className="mb-1 text-xs font-semibold">{title}</h3>
    {rows.length ? <ul className="space-y-1">{rows.map(r => <li key={r.key} className="flex items-baseline gap-2 text-xs">
      <span className="min-w-0 flex-1 truncate font-mono" title={r.main}>{r.main}</span>
      {r.meta && <span className="shrink-0 tabular-nums text-muted-foreground">{r.meta}</span>}
    </li>)}</ul> : <p className="text-xs text-muted-foreground">{empty}</p>}
  </section>;
}

/** Aggregates over recent commands: sent, failed, error signatures, durations and stuck-loop badges. */
function CommandStatsPanel({ stats }: { stats: CommandStatsData }) {
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{stats.total} completed · {stats.failed} failed</span>
      {stats.retryLoops.map(l => <Badge key={`${l.agent}-${l.command}`} variant="destructive" title={`${l.command} failed ${l.count}× for ${l.agent}`}>{l.agent}: {l.command} ×{l.count}</Badge>)}
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <StatList title="Most sent" rows={stats.mostSent.map(s => ({ key: s.command, main: s.command, meta: `${s.count}× · ${s.failed} failed` }))} empty="No commands yet." />
      <StatList title="Most failed" rows={stats.mostFailed.map(s => ({ key: s.command, main: s.command, meta: `${s.failed} failed / ${s.count}` }))} empty="No failures in this sample." />
      <StatList title="Top errors" rows={stats.topErrors.map(e => ({ key: e.error, main: e.error, meta: `${e.count}×` }))} empty="No error output recorded." />
      <StatList title="Slowest by p95" rows={stats.durations.map(d => ({ key: d.command, main: d.command, meta: `p50 ${d.p50}ms · p95 ${d.p95}ms` }))} empty="No durations recorded." />
    </div>
    <StatList title="Longest calls" rows={stats.longest.map(l => ({ key: `${l.ts}-${l.command}`, main: `${l.agent} · ${l.normalized || l.command}`, meta: `${l.duration_ms}ms` }))} empty="No durations recorded." />
  </div>;
}

const ROW: Record<DiffLine["kind"], string> = {
  add: "bg-emerald-500/15",
  del: "bg-red-500/15",
  ctx: "",
  hunk: "bg-primary/10 text-muted-foreground italic",
  meta: "text-muted-foreground italic",
};
const MARK = { add: "+", del: "-", ctx: " ", hunk: "", meta: "" } as const;

/** Numbered, colored diff rows with hunk collapse, split view and intra-line highlights. No syntax highlighter on purpose (would be a new dependency). */
function Segments({ segs }: { segs: Segment[] }) {
  return <>{segs.map((s, i) => s.changed ? <span key={i} className="rounded bg-amber-400/30">{s.text}</span> : <span key={i}>{s.text}</span>)}</>;
}

function HunkHeader({ hunk, index, collapsed, colSpan, onToggle }: { hunk: DiffHunk; index: number; collapsed: boolean; colSpan: number; onToggle: (i: number) => void }) {
  return <tr className={ROW.hunk}><td colSpan={colSpan} className="px-2 py-0.5">
    <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={!collapsed} onClick={() => onToggle(index)}>
      <span aria-hidden="true" className="inline-block w-3" style={{ transform: collapsed ? "rotate(-90deg)" : undefined }}>▾</span>
      <span className="truncate">@@ {hunk.header || "…"}</span>
      <span className="ml-auto shrink-0 tabular-nums"><span className="text-emerald-400">+{hunk.add}</span> <span className="text-red-400">-{hunk.del}</span></span>
    </button>
  </td></tr>;
}

function NumCell({ n, border }: { n?: number; border?: boolean }) {
  return <td className={cn("w-10 select-none pr-2 text-right text-muted-foreground/60 tabular-nums", border && "border-r")}>{n ?? ""}</td>;
}

function UnifiedDiff({ hunks, collapsed, toggle }: { hunks: DiffHunk[]; collapsed: Set<number>; toggle: (i: number) => void }) {
  return <table className="w-full border-collapse"><tbody>
    {hunks.map((h, hi) => {
      const marks = inlineHighlights(h.rows);
      return <Fragment key={hi}>
        <HunkHeader hunk={h} index={hi} collapsed={collapsed.has(hi)} colSpan={3} onToggle={toggle} />
        {!collapsed.has(hi) && h.rows.map((l, i) => l.kind === "meta"
          ? <tr key={i} className={ROW.meta}><td colSpan={3} className="whitespace-pre px-2 py-0.5">{l.text}</td></tr>
          : <tr key={i} className={ROW[l.kind]}>
            <NumCell n={l.old} />
            <NumCell n={l.new} border />
            <td className="whitespace-pre pl-2 pr-4"><span aria-hidden="true" className="select-none opacity-60">{MARK[l.kind]} </span>{marks.has(l) ? <Segments segs={marks.get(l)!} /> : l.text}</td>
          </tr>)}
      </Fragment>;
    })}
  </tbody></table>;
}

function SplitDiff({ hunks, collapsed, toggle }: { hunks: DiffHunk[]; collapsed: Set<number>; toggle: (i: number) => void }) {
  return <table className="w-full border-collapse"><tbody>
    {hunks.map((h, hi) => {
      const rows = splitRows(h.rows);
      return <Fragment key={hi}>
        <HunkHeader hunk={h} index={hi} collapsed={collapsed.has(hi)} colSpan={4} onToggle={toggle} />
        {!collapsed.has(hi) && rows.map((r, i) => {
          if (r.kind === "meta") return <tr key={i} className={ROW.meta}><td colSpan={4} className="whitespace-pre px-2 py-0.5">{r.old?.text}</td></tr>;
          const changed = r.kind === "change";
          return <tr key={i}>
            <NumCell n={r.old?.old} />
            <td className={cn("w-1/2 whitespace-pre pl-2", changed && "bg-red-500/15")}><span aria-hidden="true" className="select-none opacity-60">{changed && r.old ? "- " : "  "}</span>{r.pair ? <Segments segs={r.pair.left} /> : r.old?.text ?? ""}</td>
            <NumCell n={r.new?.new} border />
            <td className={cn("w-1/2 whitespace-pre pl-2 pr-4", changed && "bg-emerald-500/15")}><span aria-hidden="true" className="select-none opacity-60">{changed && r.new ? "+ " : "  "}</span>{r.pair ? <Segments segs={r.pair.right} /> : r.new?.text ?? ""}</td>
          </tr>;
        })}
      </Fragment>;
    })}
  </tbody></table>;
}

function DiffCode({ raw }: { raw: string }) {
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const parsed = parseDiff(raw);
  const toggle = (i: number) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next; });
  if (parsed.binary) return <p className="text-xs text-muted-foreground">Binary file, no textual diff to show.</p>;
  if (!parsed.lines.length) return <p className="text-xs text-muted-foreground">No textual diff</p>;
  const { preamble, hunks } = groupHunks(parsed.lines);
  const truncated = raw.length >= 200_000;
  return <div role="region" aria-label="Diff" tabIndex={0} className="max-h-[70vh] overflow-auto rounded-md border bg-background font-mono text-xs leading-5">
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b bg-background/95 px-2 py-1">
      <Button size="sm" variant={mode === "unified" ? "secondary" : "ghost"} aria-pressed={mode === "unified"} onClick={() => setMode("unified")}>Unified</Button>
      <Button size="sm" variant={mode === "split" ? "secondary" : "ghost"} aria-pressed={mode === "split"} onClick={() => setMode("split")}>Split</Button>
      {parsed.renames.length > 0 && <span className="ml-2 min-w-0 truncate text-muted-foreground" title={parsed.renames.map(r => `${r.from} → ${r.to}`).join(", ")}>renamed from {parsed.renames[0]!.from}</span>}
      <span className="ml-auto shrink-0 text-muted-foreground">{hunks.length} hunk{hunks.length === 1 ? "" : "s"}</span>
    </div>
    {truncated && <p className="border-b bg-amber-500/10 px-2 py-1 text-muted-foreground">Diff truncated at 200 KB, showing the first part.</p>}
    {preamble.length > 0 && <div className="whitespace-pre px-2 py-0.5 italic text-muted-foreground">{preamble.map((l) => l.text).join("\n")}</div>}
    {mode === "unified" ? <UnifiedDiff hunks={hunks} collapsed={collapsed} toggle={toggle} /> : <SplitDiff hunks={hunks} collapsed={collapsed} toggle={toggle} />}
  </div>;
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
  useEffect(() => {  // nothing picked yet: show the first changed file
    if (!selected) { const r = repos.find(x => x.files.length); if (r) onSelect({ root: r.root, path: r.files[0]!.path }); }
  }, [selected, repos]);
  const stats = parseDiff(diff);
  return <div className="grid min-h-0 gap-3 md:grid-cols-[minmax(12rem,1fr)_minmax(0,3fr)]">
    <Card size="sm"><CardHeader><CardTitle>Changed files</CardTitle></CardHeader><CardContent>
      {repos.map((r) => <div key={r.root} className="mb-3"><p className="mb-1 text-xs font-semibold">{r.name}</p>
        {r.files.map((f) => <Button key={f.path} variant={selected?.root === r.root && selected.path === f.path ? "secondary" : "ghost"}
          size="sm" className="h-auto w-full justify-start text-left font-mono text-xs whitespace-normal break-all"
          onClick={() => onSelect({ root: r.root, path: f.path })}>{f.status} {f.path}</Button>)}</div>)}
      {!repos.some((r) => r.files.length) && <p className="text-xs text-muted-foreground">No changed files.</p>}
    </CardContent></Card>
    <Card size="sm" className="min-w-0"><CardHeader><CardTitle className="flex flex-wrap items-baseline gap-2"><span className="break-all font-mono text-sm">{selected?.path ?? "Select a file"}</span>{selected && stats.lines.length > 0 && <span className="text-xs font-normal tabular-nums"><span className="text-emerald-400">+{stats.add}</span> <span className="text-red-400">-{stats.del}</span></span>}<span className="text-xs font-normal text-muted-foreground">live vs HEAD</span></CardTitle></CardHeader>
      <CardContent>{error && <p role="alert" className="text-destructive">{error}</p>}
        {selected ? <DiffCode raw={diff} /> : <p className="text-xs text-muted-foreground">Choose a changed file to inspect.</p>}
      </CardContent></Card>
  </div>;
}
