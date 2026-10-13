import { Fragment, lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BotIcon, GitBranchIcon, GitCompareIcon, KeyboardIcon, SettingsIcon, TerminalIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import type { Agent, Repo } from "../state";
import type { VoiceState } from "./use-voice";
import type { ViewDirective } from "../voice/intent";
import { VoicePanel, runAction, type VoiceSignal } from "./voice-panel";
import { MascotCharacter, mascotState } from "./mascot";
import { isTypingElement, NAV_FALLBACK_SELECTOR, NAV_ITEM_SELECTOR, resolveKey } from "./keyboard";
import { SettingsWindow, usePreferences } from "./settings";
import { setSpeechListening } from "./speech";
import { AlertsStrip, useAlerts } from "./alerts-view";
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

/** Panels reachable with number keys 1-5. */
const PANELS = ["dashboard", "agents", "map", "commands", "diff"] as const;
type Panel = (typeof PANELS)[number];
const PANEL_LABEL: Record<Panel, string> = { dashboard: "Dashboard", agents: "Agents", map: "Change map", commands: "Commands", diff: "Live diff" };

/** Visible rows in the active panel, used for j/k focus movement. */
function navTargets(): HTMLElement[] {
  const root = document.querySelector<HTMLElement>("[data-panel-root]");
  if (!root) return [];
  let items = Array.from(root.querySelectorAll<HTMLElement>(NAV_ITEM_SELECTOR));
  if (!items.length) items = Array.from(root.querySelectorAll<HTMLElement>(NAV_FALLBACK_SELECTOR));
  return items.filter((el) => el.offsetParent !== null);
}

/** Roving focus through the list rows, wrapping at both ends. No extra state needed. */
function moveFocus(delta: 1 | -1) {
  const items = navTargets();
  if (!items.length) return;
  const cur = items.indexOf(document.activeElement as HTMLElement);
  const next = cur < 0 ? (delta > 0 ? 0 : items.length - 1) : (cur + delta + items.length) % items.length;
  items[next]?.focus();
}

// The change map, commands panel and diff viewer only matter once their tab is opened, so
// they stay out of the initial bundle and load on first use.
const ChangeMap = lazy(() => import("./change-map").then((m) => ({ default: m.ChangeMap })));
const Dashboard = lazy(() => import("./dashboard").then((m) => ({ default: m.Dashboard })));
const CommandsView = lazy(() => import("./live-view").then((m) => ({ default: m.CommandsView })));
const DiffView = lazy(() => import("./live-view").then((m) => ({ default: m.DiffView })));
const panelFallback = (
  <div className="flex items-center justify-center p-8">
    <Spinner />
  </div>
);

const ago = (now: number, t: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const tildify = (p: string | null) => (p ?? "").replace(/^\/(home|Users)\/[^/]+/, "~");

/** Reuse the previous objects for entries that did not change, so memoized rows can skip work. */
function reuse<T>(prev: T[], next: T[]): T[] {
  if (!prev.length) return next;
  const known = new Map(prev.map((p) => [JSON.stringify(p), p]));
  return next.map((n) => known.get(JSON.stringify(n)) ?? n);
}

const DOT: Record<Agent["state"], string> = {
  working: "bg-primary hubert-working",
  idle: "bg-muted-foreground",
  closed: "bg-border",
  crashed: "bg-destructive",
};

const AgentRow = memo(function AgentRow({ a, age, child }: { a: Agent; age: string; child?: boolean }) {
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
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{age}</span>
      </div>
      <div className="truncate pl-4 text-xs text-muted-foreground">{tildify(a.repo ?? a.cwd)}</div>
      {a.doing && <div className="truncate pl-4 font-mono text-xs text-muted-foreground">{a.doing}</div>}
    </li>
  );
});

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  "??": "secondary",
  A: "secondary",
  D: "destructive",
};

async function openLazygit(root: string) {
  const r = await fetch("/api/lazygit", { method: "POST", body: JSON.stringify({ root }) }).catch(() => null);
  if (!r?.ok) toast.error(r ? await r.text() : "server down");
}

const RepoCard = memo(function RepoCard({ r, showDiff }: { r: Repo; showDiff: (root: string, path: string) => void }) {
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
});

function useSystemDark() {
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
}

function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const restore = useRef<Element | null>(null);
  useEffect(() => {
    if (open) {
      restore.current = document.activeElement;
      closeRef.current?.focus();
    } else if (restore.current instanceof HTMLElement) {
      restore.current.focus();
    }
  }, [open]);
  if (!open) return null;
  const keys: [string, string][] = [
    ["1 – 5", "Dashboard · Agents · Change map · Commands · Live diff"],
    ["j / k", "Move selection down / up"],
    ["Enter", "Open the selected file diff"],
    ["/", "Focus the filter"],
    ["?", "Show or hide this list"],
    ["Esc", "Close this list"],
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="shortcuts-title"
        className="w-full max-w-sm rounded-xl border bg-background p-5 text-foreground shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 id="shortcuts-title" className="font-semibold">Keyboard shortcuts</h2>
          <Button ref={closeRef} size="icon" variant="ghost" aria-label="Close shortcuts" onClick={onClose}><XIcon className="size-4" /></Button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
          {keys.map(([k, label]) => (
            <Fragment key={k}>
              <dt><kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{k}</kbd></dt>
              <dd className="text-muted-foreground">{label}</dd>
            </Fragment>
          ))}
        </dl>
      </div>
    </div>
  );
}

function App() {
  useSystemDark();
  const [s, setS] = useState<State | null>(null);
  const [stale, setStale] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [view, setView] = useState<Panel>(() => PANELS.find(v => v === location.hash.slice(1)) ?? "dashboard");
  const [selectedFile, setSelectedFile] = useState<{ root: string; path: string } | null>(null);
  const [showFailures, setShowFailures] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [prefs, setPrefs] = usePreferences();
  // Attention alerts derived from state plus command history (see alerts.ts).
  const { alerts, dismiss } = useAlerts(s, prefs);
  // Signals that drive the mascot's pose.
  const [thinking, setThinking] = useState(false);
  const [answeredAt, setAnsweredAt] = useState(0);
  const [voiceError, setVoiceError] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [connector, setConnector] = useState<string | null>(null);
  // Stable callbacks: memoized rows and panels then skip re-rendering when nothing changed.
  const onSelectFile = useCallback((file: { root: string; path: string } | null) => {
    setSelectedFile(file);
    setView("diff");
  }, []);
  const showDiff = useCallback((root: string, path: string) => {
    setSelectedFile({ root, path });
    setView("diff");
  }, []);
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
    if (signal.kind === "recorder") {
      setVoiceState(signal.state);
      // Never speak into the open mic: mute and cancel the moment recording starts.
      setSpeechListening(signal.state === "starting" || signal.state === "listening");
    }
    else if (signal.kind === "connector") setConnector(signal.connector);
    else if (signal.kind === "start") { setVoiceError(false); setThinking(true); }
    else if (signal.kind === "done") { setThinking(false); setAnsweredAt(signal.at); }
    else { setThinking(false); setVoiceError(true); }
  }, []);

  useEffect(() => {
    let on = true;
    let lastKey = "";
    let lastAt = 0;
    const tick = () => {
      // A hidden window shows nothing: skip the request and redraw when it comes back.
      if (document.visibilityState === "hidden") return;
      fetch("/api/state")
        .then((r) => r.json() as Promise<State>)
        .then((d) => {
          if (!on) return;
          const key = JSON.stringify([d.agents, d.repos]);
          // Same agents and same changed files: keep the current tree instead of re-rendering
          // it. The relative times get a slow refresh of their own so they do not freeze.
          if (key === lastKey && Date.now() - lastAt < 10_000) return;
          lastKey = key;
          lastAt = Date.now();
          setS((prev) => (prev ? { now: d.now, agents: reuse(prev.agents, d.agents), repos: reuse(prev.repos, d.repos) } : d));
          setStale(false);
        })
        .catch(() => on && setStale(true));
    };
    tick();
    const id = setInterval(tick, 1500);
    document.addEventListener("visibilitychange", tick);
    return () => {
      on = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = resolveKey(
        { key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey },
        { typing: isTypingElement(event.target as HTMLElement), recording: settingsOpen, overlayOpen: helpOpen, shortcut: prefs.shortcut },
      );
      if (!action) return;
      switch (action.type) {
        case "panel":
          event.preventDefault();
          if (PANELS[action.index]) setView(PANELS[action.index]!);
          break;
        case "move":
          event.preventDefault();
          moveFocus(action.delta);
          break;
        case "open": {
          // A focused button or link already opens on Enter; only reach for the first row otherwise.
          const active = document.activeElement;
          if (active instanceof HTMLElement && (active.tagName === "BUTTON" || active.tagName === "A")) break;
          navTargets()[0]?.click();
          break;
        }
        case "filter":
          event.preventDefault();
          document.querySelector<HTMLElement>("[data-filter], input[type=search]")?.focus();
          break;
        case "help":
          event.preventDefault();
          setHelpOpen(true);
          break;
        case "dismiss":
          event.preventDefault();
          setHelpOpen(false);
          break;
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [settingsOpen, helpOpen, prefs.shortcut]);

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
          <Button size="icon" variant="ghost" aria-label="Keyboard shortcuts" aria-keyshortcuts="?" onClick={() => setHelpOpen(true)}><KeyboardIcon /></Button>
          <Button size="icon" variant="ghost" aria-label="Settings" onClick={() => setSettingsOpen(true)}><SettingsIcon /></Button>
          <Switch id="closed" size="sm" checked={showClosed} onCheckedChange={setShowClosed} />
          <Label htmlFor="closed" className="text-xs text-muted-foreground">
            closed
          </Label>
        </div>
      </header>
      <Separator />
      <AlertsStrip alerts={alerts} onDismiss={dismiss} />
      <VoicePanel preferences={prefs} paused={settingsOpen} onSignal={onVoiceSignal} applyView={applyView} onOpenSettings={() => setSettingsOpen(true)} />
      <Separator />
      <nav aria-label="Hubert panels" className="flex flex-wrap gap-1 px-4 py-2">
        {PANELS.map((tab, i) =>
          <Button key={tab} aria-pressed={view === tab} aria-keyshortcuts={String(i + 1)} variant={view === tab ? "secondary" : "ghost"} size="sm" onClick={() => setView(tab)}>
            {PANEL_LABEL[tab]}
          </Button>)}
      </nav>
      <div data-panel-root className="flex min-h-0 flex-1 flex-col">
      {view === "dashboard" ? (
        <Suspense fallback={<div className="flex min-h-0 flex-1 items-center justify-center"><Spinner /></div>}>
          <Dashboard agents={s.agents} repos={s.repos} now={s.now} showClosed={showClosed} selected={selectedFile} onSelect={setSelectedFile} />
        </Suspense>
      ) : <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          <Suspense fallback={panelFallback}>
          {view === "commands" && <CommandsView onlyFailed={showFailures} />}
          {view === "map" && <ChangeMap repos={s.repos} onSelect={onSelectFile} />}
          {view === "diff" && <DiffView repos={s.repos} selected={selectedFile} onSelect={setSelectedFile} />}
          </Suspense>
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
                    <AgentRow key={a.id} a={a} age={ago(s.now, a.lastActive)} />,
                    ...kids(a.id).map((k) => <AgentRow key={k.id} a={k} age={ago(s.now, k.lastActive)} child />),
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
            <RepoCard key={r.root} r={r} showDiff={showDiff} />
          ))}
          {!s.repos.length && roots.length > 0 && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <GitCompareIcon className="size-4" /> No live agent is inside a git repo.
            </p>
          )}
          </>}
        </div>
      </ScrollArea>}
      </div>
      <SettingsWindow open={settingsOpen} onClose={() => setSettingsOpen(false)} preferences={prefs} onChange={setPrefs} connector={connector} />
      <ShortcutsOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Toaster />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <App />
  </TooltipProvider>,
);
