import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { State } from "../state";
import type { Command } from "../live";
import type { Preferences } from "./preferences";
import { speakReply } from "./speech";
import { detectAlerts, freshAlerts, nextWorkingSince, notifyAlert, type Alert, type Observed } from "./alerts";
import { cn } from "@/lib/utils";

/** Poll commands a little slower than state: retry loops do not need 1.5s resolution. */
const COMMAND_POLL_MS = 4000;

/**
 * Watch state and command history, detect attention alerts, and keep each one until
 * its condition clears. Fresh alerts optionally raise a desktop notification and a
 * spoken line (both off by default). Dedupe lives in freshAlerts so an alert fires once.
 */
export function useAlerts(state: State | null, prefs: Preferences) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const prev = useRef<Observed | null>(null);
  const suppressed = useRef<Set<string>>(new Set());
  const commands = useRef<Command[]>([]);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    let active = true;
    const load = () => {
      void fetch("/api/commands").then((r) => (r.ok ? r.json() as Promise<Command[]> : [])).then((data) => { if (active) commands.current = data; }).catch(() => {});
    };
    load();
    const timer = setInterval(load, COMMAND_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!state || prev.current?.now === state.now) return;
    const next: Observed = { now: state.now, agents: state.agents, repos: state.repos, workingSince: nextWorkingSince(prev.current, state.agents, state.now) };
    const detected = detectAlerts(prev.current, next, commands.current);
    prev.current = next;
    const { fresh, suppressed: keep } = freshAlerts(suppressed.current, detected);
    suppressed.current = keep;
    const currentIds = new Set(detected.map((a) => a.id));
    setAlerts((shown) => {
      const kept = shown.filter((a) => currentIds.has(a.id));
      const added = fresh.filter((a) => !kept.some((k) => k.id === a.id));
      return added.length ? [...kept, ...added] : kept;
    });
    for (const a of fresh) {
      if (prefsRef.current.notifyAlerts) notifyAlert(`hubert: ${a.title}`, a.detail);
      if (prefsRef.current.speakReplies) speakReply(a.detail, "alert", prefsRef.current);
    }
  }, [state]);

  const dismiss = useCallback((id: string) => setAlerts((shown) => shown.filter((a) => a.id !== id)), []);
  return { alerts, dismiss };
}

/** Compact one-line strip of active alerts, newest first. Renders nothing when empty. */
export function AlertsStrip({ alerts, onDismiss }: { alerts: Alert[]; onDismiss: (id: string) => void }) {
  if (!alerts.length) return null;
  return (
    <div role="status" aria-label="Alerts" className="flex flex-wrap items-center gap-2 px-4 py-2">
      {alerts.map((a) => (
        <div key={a.id} className={cn("flex min-w-0 items-center gap-2 rounded-md border px-2 py-1 text-xs",
          a.severity === "warn" ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/40")}>
          {a.severity === "warn"
            ? <TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
            : <CheckCircle2Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="shrink-0 font-medium">{a.title}</span>
          <span className="min-w-0 truncate text-muted-foreground" title={a.detail}>{a.detail}</span>
          <button type="button" aria-label={`Dismiss ${a.title}`} onClick={() => onDismiss(a.id)}
            className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <XIcon className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
