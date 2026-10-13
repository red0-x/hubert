import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BotIcon, GitBranchIcon, GitCompareIcon, SettingsIcon, TerminalIcon } from "lucide-react";
import { toast } from "sonner";
import type { Agent, Repo } from "../state";
import type { VoiceState } from "./use-voice";
import type { ViewDirective } from "../voice/intent";
import { VoicePanel, runAction, type VoiceSignal } from "./voice-panel";
import { MascotCharacter, mascotState } from "./mascot";
import { SettingsWindow, usePreferences } from "./settings";
import { ChangeMap, CommandsView, DiffView } from "./live-view";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type State = { now: number; agents: Agent[]; repos: Repo[] };

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

function AgentRow({ a, now, child }: { a: Agent; now: number; child?: boolean }) {
  return (
    <li className={cn("flex flex-col gap-0.5 py-1.5", child && "pl-5", (a.state === "closed" || a.state === "crashed") && "opacity-60")}>
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", DOT[a.state])} aria-label={a.state} />
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="truncate font-medium hover:underline disabled:no-underline" disabled={a.source !== "jcode" || (a.state !== "idle" && a.state !== "working")}
              onClick={() => void runAction({ type: "focus", agent: a.name, needsConfirm: false }, false)}>{a.name}</button>
          </TooltipTrigger>
          {a.title && <TooltipContent className="max-w-xs">{a.title}</TooltipContent>}
        </Tooltip>
        <Badge variant="outline">{a.source}</Badge>
        {a.state === "crashed" && <Badge variant="destructive">crashed</Badge>}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{ago(now, a.lastActive)}</span>
      </div>
      <div className="truncate pl-4 text-xs text-muted-foreground">{tildify(a.repo ?? a.cwd)}</div>
      {a.doing && <div className="truncate pl-4 font-mono text-xs text-muted-foreground">{a.doing}</div>}
    </li>
  );
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  "??": "secondary",
  A: "secondary",
  D: "destructive",
};

async function openLazygit(root: string) {
  const r = await fetch("/api/lazygit", { method: "POST", body: JSON.stringify({ root }) }).catch(() => null);
  if (!r?.ok) toast.error(r ? await r.text() : "server down");
}

function RepoCard({ r, showDiff }: { r: Repo; showDiff: (root: string, path: string) => void }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranchIcon className="size-4 text-muted-foreground" />
          {r.name}
        </CardTitle>
        <CardDescription className="truncate">
          {r.branch} · {r.agents.join(", ")}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => openLazygit(r.root)}>
            <TerminalIcon data-icon="inline-start" />
            lazygit
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {r.files.length ? (
          <ul className="flex flex-col gap-1 font-mono text-xs">
            {r.files.map((f) => (
              <li key={f.path} className="flex items-center gap-2">
                <Badge variant={STATUS_VARIANT[f.status] ?? "outline"} className="w-7 justify-center">
                  {f.status}
                </Badge>
                <button className="truncate text-left hover:underline focus-visible:underline" title={`Show diff for ${f.path}`} onClick={() => showDiff(r.root, f.path)}>
                  {f.path}
                </button>
                <span className="ml-auto flex shrink-0 gap-1 tabular-nums">
                  {f.add > 0 && <span>+{f.add}</span>}
                  {f.del > 0 && <span className="text-destructive">-{f.del}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">Working tree clean</p>
        )}
      </CardContent>
    </Card>
  );
}

function useSystemDark() {
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
}

function App() {
  useSystemDark();
  const [s, setS] = useState<State | null>(null);
  const [stale, setStale] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [view, setView] = useState<"agents" | "map" | "commands" | "diff">(() => (["agents", "map", "commands", "diff"] as const).find(v => v === location.hash.slice(1)) ?? "agents");
  const [selectedFile, setSelectedFile] = useState<{ root: string; path: string } | null>(null);
  const [showFailures, setShowFailures] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefs, setPrefs] = usePreferences();
  // Signals that drive the mascot's pose.
  const [thinking, setThinking] = useState(false);
  const [answeredAt, setAnsweredAt] = useState(0);
  const [voiceError, setVoiceError] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [connector, setConnector] = useState<string | null>(null);
  // Voice view switches run here in the window: no server action, no confirmation.
  const applyView = useCallback((v: ViewDirective) => {
    if (v.failuresOnly !== undefined) setShowFailures(v.failuresOnly);
    if (v.repo) {
      const r = s?.repos.find((x) => x.name === v.repo);
      const f = r?.files[0];
      setSelectedFile(r && f ? { root: r.root, path: f.path } : null);
      setView(v.panel ?? (r && f ? "diff" : "map"));
    } else if (v.panel) setView(v.panel);
  }, [s]);
  // The voice panel owns the recorder and its shortcut; these signals drive the mascot and settings.
  const onVoiceSignal = useCallback((signal: VoiceSignal) => {
    if (signal.kind === "recorder") setVoiceState(signal.state);
    else if (signal.kind === "connector") setConnector(signal.connector);
    else if (signal.kind === "start") { setVoiceError(false); setThinking(true); }
    else if (signal.kind === "done") { setThinking(false); setAnsweredAt(signal.at); }
    else { setThinking(false); setVoiceError(true); }
  }, []);

  useEffect(() => {
    let on = true;
    const tick = () =>
      fetch("/api/state")
        .then((r) => r.json() as Promise<State>)
        .then((d) => on && (setS(d), setStale(false)))
        .catch(() => on && setStale(true));
    tick();
    const id = setInterval(tick, 1500);
    return () => {
      on = false;
      clearInterval(id);
    };
  }, []);

  if (!s)
    return (
      <div className="flex h-svh items-center justify-center gap-2 text-sm text-muted-foreground">
        {stale ? "hubert server is not running" : <Spinner />}
      </div>
    );

  const visible = s.agents.filter((a) => showClosed || a.state === "working" || a.state === "idle");
  const ids = new Set(visible.map((a) => a.id));
  const roots = visible.filter((a) => !a.parent || !ids.has(a.parent));
  const kids = (id: string) => visible.filter((a) => a.parent === id);
  const working = s.agents.filter((a) => a.state === "working").length;
  const mascot = mascotState({ stale, error: voiceError, voice: voiceState, thinking, answeredAt, now: Date.now() });

  return (
    <div className="flex h-svh flex-col">
      <header className="flex items-center gap-2 px-4 py-3">
        <img src="/docs/logo.png" alt="hubert" className="size-7 object-contain" />
        <h1 className="font-semibold">hubert</h1>
        <Badge variant={working ? "default" : "secondary"}>{working} working</Badge>
        {stale && <Badge variant="destructive">stale</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <MascotCharacter state={mascot} />
          <Button size="icon" variant="ghost" aria-label="Settings" onClick={() => setSettingsOpen(true)}><SettingsIcon /></Button>
          <Switch id="closed" size="sm" checked={showClosed} onCheckedChange={setShowClosed} />
          <Label htmlFor="closed" className="text-xs text-muted-foreground">
            closed
          </Label>
        </div>
      </header>
      <Separator />
      <VoicePanel preferences={prefs} paused={settingsOpen} onSignal={onVoiceSignal} applyView={applyView} onOpenSettings={() => setSettingsOpen(true)} />
      <Separator />
      <nav aria-label="Hubert panels" className="flex gap-1 px-4 py-2">
        {(["agents", "map", "commands", "diff"] as const).map((tab) =>
          <Button key={tab} aria-pressed={view === tab} variant={view === tab ? "secondary" : "ghost"} size="sm" onClick={() => setView(tab)}>
            {tab === "agents" ? "Agents" : tab === "map" ? "Change map" : tab === "commands" ? "Commands" : "Live diff"}
          </Button>)}
      </nav>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          {view === "commands" && <CommandsView onlyFailed={showFailures} />}
          {view === "map" && <ChangeMap repos={s.repos} onSelect={(file) => { setSelectedFile(file); setView("diff"); }} />}
          {view === "diff" && <DiffView repos={s.repos} selected={selectedFile} onSelect={setSelectedFile} />}
          {view === "agents" && <>
          <Card size="sm">
            <CardHeader>
              <CardTitle>Agents</CardTitle>
              <CardDescription>{s.agents.length} seen in the last 30 min</CardDescription>
            </CardHeader>
            <CardContent>
              {roots.length ? (
                <ul className="flex flex-col divide-y">
                  {roots.map((a) => [
                    <AgentRow key={a.id} a={a} now={s.now} />,
                    ...kids(a.id).map((k) => <AgentRow key={k.id} a={k} now={s.now} child />),
                  ])}
                </ul>
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <BotIcon />
                    </EmptyMedia>
                    <EmptyTitle>No agents running</EmptyTitle>
                    <EmptyDescription>Start a jcode or Claude Code session and it shows up here.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>
          {s.repos.map((r) => (
            <RepoCard key={r.root} r={r} showDiff={(root, path) => { setSelectedFile({ root, path }); setView("diff"); }} />
          ))}
          {!s.repos.length && roots.length > 0 && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <GitCompareIcon className="size-4" /> No live agent is inside a git repo.
            </p>
          )}
          </>}
        </div>
      </ScrollArea>
      <SettingsWindow open={settingsOpen} onClose={() => setSettingsOpen(false)} preferences={prefs} onChange={setPrefs} connector={connector} />
      <Toaster />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <App />
  </TooltipProvider>,
);
