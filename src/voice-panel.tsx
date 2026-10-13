import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangleIcon, ArrowRightIcon, CheckIcon, InfoIcon, MicIcon, SettingsIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import type { ViewDirective } from "../voice/intent";
import { shortcutLabel, type Preferences } from "./preferences";
import { speakReply } from "./speech";
import { useVoice, type VoiceState } from "./use-voice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type PlanAction = { type: string; agent?: string; text?: string; address?: string; x?: number; y?: number; width?: number; height?: number; workspace?: number; targetTitle?: string; needsConfirm: boolean };

export const actionLabel = (a: PlanAction) =>
  a.type === "send" ? `Tell ${a.agent}: ${a.text}` : a.type === "move" ? `Move ${a.targetTitle ?? a.address} (${a.address}) to ${a.x}, ${a.y}` : a.type === "workspace" ? `Move ${a.targetTitle ?? a.address} to workspace ${a.workspace}` : a.type === "resize" ? `Resize ${a.targetTitle ?? a.address} (${a.address}) to ${a.width} × ${a.height}` : a.type === "focus" ? `Focus ${a.agent}` : a.type === "stop" ? `Interrupt ${a.agent}` : `Status of ${a.agent}`;

/** Execute one plan action. Returns the result text, or null when it failed (already toasted). */
export async function runAction(a: PlanAction, confirmed: boolean, _speakReplies = false): Promise<string | null> {
  const { needsConfirm, ...action } = a;
  const r = await fetch("/api/execute", { method: "POST", body: JSON.stringify({ action, confirmed }) }).catch(() => null);
  if (!r) { toast.error("hubert server is not reachable"); return null; }
  const body = await r.text();
  if (!r.ok) { toast.error(body); return null; }
  return (JSON.parse(body) as { result: string }).result;
}

/** One-shot signals the panel raises so the shell can drive the mascot and settings. */
export type VoiceSignal =
  | { kind: "recorder"; state: VoiceState }
  | { kind: "connector"; connector: string | null }
  | { kind: "start" }
  | { kind: "done"; at: number }
  | { kind: "error" };

type Plan = { say: string; actions: PlanAction[]; dropped: string[]; via: string; view?: ViewDirective; ms?: number };
type Exchange = {
  id: number; text: string; connector: string; via: string; say: string;
  dropped: string[]; pending: PlanAction[]; result: string | null;
  status: "thinking" | "done" | "error"; error: string | null; at: number;
};

const MAX_EXCHANGES = 5;
const SEGMENTS = 20;

export function VoicePanel({ preferences, paused = false, onSignal, applyView, onOpenSettings }: {
  preferences: Preferences;
  paused?: boolean;
  onSignal: (signal: VoiceSignal) => void;
  applyView: (v: ViewDirective) => void;
  onOpenSettings: () => void;
}) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const nextId = useRef(0);
  const deps = useRef({ onSignal, applyView, preferences, quiet: false });
  deps.current = { ...deps.current, onSignal, applyView, preferences };

  const handleSpeech = useCallback(async (text: string, connector: string, sttMs?: number) => {
    const id = ++nextId.current;
    const base: Exchange = { id, text, connector, via: "", say: "", dropped: [], pending: [], result: null, status: "thinking", error: null, at: Date.now() };
    setExchanges((prev) => [base, ...prev].slice(0, MAX_EXCHANGES));
    deps.current.onSignal({ kind: "start" });
    const r = await fetch("/api/voice", { method: "POST", body: JSON.stringify({ text }) }).catch(() => null);
    if (!r?.ok) {
      const msg = r ? await r.text() : "hubert server is not reachable";
      deps.current.onSignal({ kind: "error" });
      toast.error(`Could not plan “${text}”`, { description: msg });
      setExchanges((prev) => prev.map((x) => (x.id === id ? { ...x, status: "error", error: msg } : x)));
      return;
    }
    const plan = (await r.json()) as Plan;
    deps.current.onSignal({ kind: "done", at: Date.now() });
    // Latency of each hop, so a slow mic, whisper or model is obvious at a glance.
    const timing = [sttMs != null ? `stt ${Math.round(sttMs)} ms` : null, plan.ms != null ? `plan ${Math.round(plan.ms)} ms` : null].filter((s): s is string => !!s).join(" · ");
    toast.success(`“${text}”`, { description: timing ? `${timing} · ${plan.via}` : plan.via });
    if (plan.view) deps.current.applyView(plan.view);
    // Spoken replies stay silent while the mic is open, so a reply is never recorded back.
    const prefs = deps.current.preferences;
    const spoken = prefs.speakReplies && !deps.current.quiet;
    // A plan with no actions is pure speech; otherwise the action result is what gets read.
    if (spoken && plan.say && !plan.actions.length) speakReply(plan.say, "answer", prefs);
    let result: string | null = null;
    let lastType: PlanAction["type"] | null = null;
    for (const a of plan.actions) {
      if (!a.needsConfirm) { const res = await runAction(a, false); if (res != null) { result = res; lastType = a.type; } }
    }
    if (spoken && result && lastType) speakReply(result, lastType === "status" ? "answer" : "ack", prefs);
    const pending = plan.actions.filter((a) => a.needsConfirm);
    if (!plan.actions.length && !plan.say) result = "No matching command";
    setExchanges((prev) => prev.map((x) => (x.id === id ? { ...x, via: plan.via, say: plan.say, dropped: plan.dropped, pending, result, status: "done" } : x)));
  }, []);

  const onError = useCallback((message: string) => { deps.current.onSignal({ kind: "error" }); toast.error(message); }, []);

  const voice = useVoice(handleSpeech, onError);
  // While the mic is open, spoken output is suppressed so a reply is never recorded back into the next transcript.
  deps.current.quiet = voice.state === "starting" || voice.state === "listening";

  useEffect(() => { onSignal({ kind: "recorder", state: voice.state }); }, [voice.state, onSignal]);
  useEffect(() => { onSignal({ kind: "connector", connector: voice.stt?.active ?? null }); }, [voice.stt, onSignal]);

  // Shortcut owns start/stop while Hubert is focused, outside fields and buttons.
  const { start, stop, cancel, state: voiceState, level } = voice;
  const canRecord = !!voice.stt?.active;
  useEffect(() => {
    if (paused) { cancel(); return; }
    if (!canRecord) return;
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && !!e.target.closest("input,textarea,select,button,[contenteditable]");
    const down = (e: KeyboardEvent) => {
      if (e.code === "Escape") return cancel();
      if (e.code !== preferences.shortcut || e.repeat || e.ctrlKey || e.altKey || e.metaKey || typing(e)) return;
      e.preventDefault();
      if (preferences.voiceMode === "hold") start();
      else if (voiceState === "listening") stop(); else start();
    };
    const up = (e: KeyboardEvent) => { if (preferences.voiceMode === "hold" && e.code === preferences.shortcut) stop(); };
    addEventListener("keydown", down); addEventListener("keyup", up);
    return () => { removeEventListener("keydown", down); removeEventListener("keyup", up); };
  }, [paused, canRecord, preferences.shortcut, preferences.voiceMode, voiceState, start, stop, cancel]);

  const confirm = useCallback(async (id: number, action: PlanAction) => {
    const res = await runAction(action, true);
    if (res && deps.current.preferences.speakReplies && !deps.current.quiet) speakReply(res, action.type === "status" ? "answer" : "ack", deps.current.preferences);
    setExchanges((prev) => prev.map((x) => (x.id === id ? { ...x, pending: x.pending.filter((p) => p !== action), result: res ?? x.result } : x)));
  }, []);
  const dismiss = useCallback((id: number, action: PlanAction) => {
    setExchanges((prev) => prev.map((x) => (x.id === id ? { ...x, pending: x.pending.filter((p) => p !== action) } : x)));
  }, []);

  const micOff = !voice.stt?.active;
  const listening = voiceState === "listening";
  const transcribing = voiceState === "transcribing";
  const thinking = exchanges[0]?.status === "thinking";
  const latest = exchanges[0];
  const history = exchanges.slice(1);

  return (
    <section aria-label="Voice control" className="flex flex-col items-center gap-5 px-4 pt-4 pb-6">
      <div className="flex w-full max-w-4xl flex-col items-center gap-6 md:flex-row md:items-stretch">
        <div className="flex shrink-0 flex-col items-center justify-center gap-3">
          <MicButton mode={preferences.voiceMode} state={voiceState} micOff={micOff} level={level} onStart={start} onStop={stop} />
          <p role="status" aria-live="polite" className="text-sm font-medium">
            {micOff ? "Microphone off" : voiceState === "starting" ? "Starting the microphone…" : listening ? "Listening…" : transcribing ? "Transcribing…" : thinking ? "Thinking…" : preferences.shortcut ? `${preferences.voiceMode === "hold" ? "Hold" : "Press"} ${shortcutLabel(preferences.shortcut)} to talk` : "Click the mic to talk"}
          </p>
          <LevelMeter level={level} active={listening} />
          <ShortcutHint preferences={preferences} onOpenSettings={onOpenSettings} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-3">
          {listening && voice.draft && <DraftCard text={voice.draft} />}
          {micOff ? (
            <NoConnector onOpenSettings={onOpenSettings} />
          ) : latest ? (
            <ExchangeCard x={latest} onConfirm={confirm} onDismiss={dismiss} />
          ) : (
            <ReadyPrompt />
          )}
        </div>
      </div>
      {history.length > 0 && <HistoryList items={history} onConfirm={confirm} onDismiss={dismiss} />}
    </section>
  );
}

function MicButton({ mode, state, micOff, level, onStart, onStop }: {
  mode: Preferences["voiceMode"]; state: VoiceState; micOff: boolean; level: number;
  onStart: () => void; onStop: () => void;
}) {
  const listening = state === "listening";
  const transcribing = state === "transcribing";
  return (
    <button
      type="button"
      disabled={micOff || transcribing}
      aria-label={micOff ? "Microphone unavailable, no speech connector configured" : mode === "hold" ? "Hold to talk" : listening ? "Stop recording" : "Start recording"}
      aria-pressed={listening}
      onPointerDown={mode === "hold" && !micOff ? onStart : undefined}
      onPointerUp={mode === "hold" ? onStop : undefined}
      onPointerLeave={mode === "hold" ? onStop : undefined}
      onPointerCancel={mode === "hold" ? onStop : undefined}
      onClick={mode === "toggle" && !micOff ? () => (listening ? onStop() : onStart()) : undefined}
      className={cn(
        "relative flex size-28 items-center justify-center rounded-full border-2 outline-none transition-all select-none focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/50",
        listening ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted",
        (micOff || transcribing) && "cursor-not-allowed opacity-60",
      )}
    >
      {listening && <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full ring-4 ring-primary/40" style={{ transform: `scale(${1 + level * 0.3})` }} />}
      {transcribing ? <Spinner className="size-9" /> : <MicIcon aria-hidden="true" className={cn("size-10", listening && "animate-pulse")} />}
    </button>
  );
}

function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const lit = active ? Math.round(level * SEGMENTS) : 0;
  return (
    <div role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={active ? Math.round(level * 100) : 0}
      className="flex h-2.5 w-44 items-center gap-0.5">
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span key={i} className={cn("h-full flex-1 rounded-full transition-colors", i < lit ? "bg-primary" : "bg-muted")} />
      ))}
    </div>
  );
}

function ShortcutHint({ preferences, onOpenSettings }: { preferences: Preferences; onOpenSettings: () => void }) {
  return (
    <p className="text-xs text-muted-foreground">
      {preferences.shortcut ? (
        <>
          {preferences.voiceMode === "hold" ? "Hold" : "Press"}{" "}
          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[0.7rem]">{shortcutLabel(preferences.shortcut)}</kbd> to talk · Escape cancels
        </>
      ) : (
        <>
          No shortcut set ·{" "}
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={onOpenSettings}>set one in Settings</button>
        </>
      )}
    </p>
  );
}

function DraftCard({ text }: { text: string }) {
  return (
    <Card size="sm" className="min-w-0 border-dashed">
      <CardContent className="flex min-w-0 flex-col gap-2">
        <Badge variant="outline" className="self-start">draft</Badge>
        <p className="text-lg leading-snug font-medium break-words text-muted-foreground">“{text}”</p>
      </CardContent>
    </Card>
  );
}

function ReadyPrompt() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 py-6 text-center">
      <p className="text-sm font-medium">Ready when you are</p>
      <p className="text-xs text-muted-foreground">Try “focus snail”, “what is snake doing”, or “tell llama to review the nav”.</p>
    </div>
  );
}

function NoConnector({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <Card size="sm" className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm"><InfoIcon className="size-4 text-destructive" />No speech connector configured</CardTitle>
        <CardDescription>
          Set <code className="font-mono">HUBERT_STT</code> to whisper-socket, command, openai-compatible, groq, openai or deepgram, then restart Hubert. See the README “Voice control” section.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button size="sm" variant="outline" onClick={onOpenSettings}><SettingsIcon data-icon="inline-start" />Open settings</Button>
      </CardContent>
    </Card>
  );
}

function ExchangeCard({ x, onConfirm, onDismiss }: { x: Exchange; onConfirm: (id: number, a: PlanAction) => void; onDismiss: (id: number, a: PlanAction) => void }) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-xs font-normal text-muted-foreground">
          <Badge variant="secondary">you</Badge>
          <span className="truncate">{x.connector}</span>
          {x.via && <span className="truncate">· {x.via}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <p className="text-lg leading-snug font-medium break-words">“{x.text}”</p>
        {x.status === "thinking" && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Thinking…</p>}
        {x.status === "error" && <p role="alert" className="text-sm text-destructive">{x.error}</p>}
        {x.status === "done" && (
          <>
            {x.say && <p className="flex items-start gap-2 text-sm"><ArrowRightIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span>{x.say}</span></p>}
            {x.result && <p className="rounded-md bg-muted px-3 py-2 text-sm">{x.result}</p>}
            {x.dropped.map((d) => <p key={d} className="flex items-center gap-2 text-xs text-muted-foreground"><AlertTriangleIcon aria-hidden="true" className="size-3.5" />Ignored: {d}</p>)}
            {x.pending.length > 0 && <div className="flex flex-col gap-2">
              {x.pending.map((a, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                  <span className="min-w-0 flex-1 text-sm">{actionLabel(a)}</span>
                  <Button size="sm" onClick={() => onConfirm(x.id, a)}><CheckIcon data-icon="inline-start" />Do it</Button>
                  <Button size="sm" variant="ghost" onClick={() => onDismiss(x.id, a)}><XIcon data-icon="inline-start" />Cancel</Button>
                </div>
              ))}
            </div>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function HistoryList({ items, onConfirm, onDismiss }: { items: Exchange[]; onConfirm: (id: number, a: PlanAction) => void; onDismiss: (id: number, a: PlanAction) => void }) {
  return (
    <div className="w-full max-w-4xl">
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recent voice</h2>
      <ul className="flex flex-col divide-y rounded-xl border">
        {items.map((x) => (
          <li key={x.id} className="flex min-w-0 flex-col gap-1 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">“{x.text}”</span>
              <Badge variant={x.status === "error" ? "destructive" : x.status === "thinking" ? "outline" : "secondary"}>{x.status === "error" ? "failed" : x.status === "thinking" ? "thinking" : "done"}</Badge>
            </div>
            {(x.error || x.result || x.say) && <p className="truncate text-xs text-muted-foreground">{x.error ?? x.result ?? x.say}</p>}
            {x.pending.length > 0 && <div className="flex flex-wrap items-center gap-2">
              {x.pending.map((a, i) => (
                <span key={i} className="flex items-center gap-1">
                  <span className="truncate text-xs">{actionLabel(a)}</span>
                  <Button size="xs" onClick={() => onConfirm(x.id, a)}>Do it</Button>
                  <Button size="xs" variant="ghost" onClick={() => onDismiss(x.id, a)}>Cancel</Button>
                </span>
              ))}
            </div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
