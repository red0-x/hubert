import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BotIcon, GitBranchIcon, GitCompareIcon, MicIcon, TerminalIcon } from "lucide-react";
import { toast } from "sonner";
import type { Agent, Repo } from "../state";
import { useVoice } from "./use-voice";
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

type PlanAction = { type: string; agent?: string; repo?: string; text?: string; prompt?: string; needsConfirm: boolean };
const label = (a: PlanAction) =>
  a.type === "send" ? `Tell ${a.agent}: ${a.text}` : a.type === "open" ? `Open new agent${a.repo ? ` in ${a.repo}` : ""}${a.prompt ? ` (${a.prompt})` : ""}` : a.type === "focus" ? `Focus ${a.agent}` : `Status of ${a.agent}`;

async function runAction(a: PlanAction, confirmed: boolean) {
  const { needsConfirm, ...action } = a;
  const r = await fetch("/api/execute", { method: "POST", body: JSON.stringify({ action, confirmed }) }).catch(() => null);
  if (!r) return toast.error("hubert server is not reachable");
  const body = await r.text();
  if (!r.ok) return toast.error(body);
  toast.success((JSON.parse(body) as { result: string }).result);
}

/** Transcript -> plan (grammar first, light model otherwise). Focus/status run now; send/open wait for a click. */
async function handleSpeech(text: string, connector: string) {
  const id = toast.loading(`“${text}”`, { description: "Thinking…" });
  const r = await fetch("/api/voice", { method: "POST", body: JSON.stringify({ text }) }).catch(() => null);
  if (!r?.ok) return toast.error(r ? await r.text() : "hubert server is not reachable", { id });
  const plan = (await r.json()) as { say: string; actions: PlanAction[]; dropped: string[]; via: string };
  toast.dismiss(id);
  const desc = `${plan.via === "grammar" ? "" : `${plan.via} \u00b7 `}${connector}`;
  if (!plan.actions.length) return toast(plan.say || "No matching command", { description: `“${text}” \u00b7 ${desc}` });
  for (const a of plan.actions) {
    if (!a.needsConfirm) await runAction(a, false);
    else toast(label(a), { description: `${plan.say} \u00b7 ${desc}`, duration: 15000, action: { label: "Do it", onClick: () => void runAction(a, true) }, cancel: { label: "Cancel", onClick: () => {} } });
  }
  for (const d of plan.dropped) toast.warning(`Ignored: ${d}`);
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

function AgentRow({ a, now, child }: { a: Agent; now: number; child?: boolean }) {
  return (
    <li className={cn("flex flex-col gap-0.5 py-1.5", child && "pl-5", (a.state === "closed" || a.state === "crashed") && "opacity-60")}>
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", DOT[a.state])} aria-label={a.state} />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="truncate font-medium">{a.name}</span>
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

function RepoCard({ r }: { r: Repo }) {
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
                <span className="truncate" title={f.path}>
                  {f.path}
                </span>
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
  const voice = useVoice(
    handleSpeech,
    useCallback((msg: string) => toast.error(msg), []),
  );

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
  const micOff = !voice.stt?.active;
  const micTip = voice.stt?.active ? `Hold to talk (${voice.stt.active})` : "No speech-to-text connector configured, see README";

  return (
    <div className="flex h-svh flex-col">
      <header className="flex items-center gap-2 px-4 py-3">
        <h1 className="font-semibold">hubert</h1>
        <Badge variant={working ? "default" : "secondary"}>{working} working</Badge>
        {stale && <Badge variant="destructive">stale</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  size="icon"
                  variant={voice.state === "listening" ? "default" : "outline"}
                  disabled={micOff || voice.state === "transcribing"}
                  aria-label="Hold to talk"
                  onPointerDown={voice.start}
                  onPointerUp={voice.stop}
                  onPointerLeave={voice.stop}
                >
                  {voice.state === "transcribing" ? <Spinner /> : <MicIcon className={voice.state === "listening" ? "animate-pulse" : ""} />}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{micTip}</TooltipContent>
          </Tooltip>
          <Switch id="closed" size="sm" checked={showClosed} onCheckedChange={setShowClosed} />
          <Label htmlFor="closed" className="text-xs text-muted-foreground">
            closed
          </Label>
        </div>
      </header>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
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
            <RepoCard key={r.root} r={r} />
          ))}
          {!s.repos.length && roots.length > 0 && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <GitCompareIcon className="size-4" /> No live agent is inside a git repo.
            </p>
          )}
        </div>
      </ScrollArea>
      <Toaster />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <App />
  </TooltipProvider>,
);
