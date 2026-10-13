import { useCallback, useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DEFAULT_PREFERENCES, SPEAK_PITCH_MAX, SPEAK_PITCH_MIN, SPEAK_RATE_MAX, SPEAK_RATE_MIN, parsePreferences, PREFERENCES_KEY, shortcutLabel, validShortcut, type Preferences } from "./preferences";
import { listVoices, speechDiagnostic, type SpeechGlobal, type SpeechVoice } from "./speech";
import { notificationsSupported } from "./alerts";

// Mirrors DoctorReport from ../doctor.ts. Duplicated rather than imported so the client
// bundle never pulls in the server-side node/Bun bits.
type DoctorStatus = "ok" | "warn" | "error";
type DoctorReport = { status: DoctorStatus; port: number; checks: { id: string; label: string; status: DoctorStatus; detail: string; hint?: string }[] };

const DOCTOR_DOT: Record<DoctorStatus, string> = { ok: "bg-emerald-500", warn: "bg-amber-500", error: "bg-destructive" };

/** First-run health check backed by GET /api/doctor. Re-fetched every time Settings opens. */
function DoctorSection({ open }: { open: boolean }) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    fetch("/api/doctor").then((r) => r.json() as Promise<DoctorReport>).then(setReport).catch(() => setFailed(true));
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);
  return <section className="space-y-2">
    <div className="flex items-center justify-between">
      <h3 id="doctor-title" className="text-sm font-medium">Health check</h3>
      <Button size="sm" variant="ghost" onClick={load}>Re-check</Button>
    </div>
    {failed ? <p className="text-xs text-destructive">Could not reach the server.</p>
      : !report ? <p className="text-xs text-muted-foreground">Checking…</p>
      : <ul className="space-y-2" aria-labelledby="doctor-title">
        {report.checks.map((c) => <li key={c.id} className="flex gap-2 text-xs">
          <span className={cn("mt-1 size-2 shrink-0 rounded-full", DOCTOR_DOT[c.status])} aria-label={c.status} role="img" />
          <span className="min-w-0">
            <span className="font-medium text-foreground">{c.label}</span>{" "}
            <span className="break-words text-muted-foreground">{c.detail}</span>
            {c.hint && <span className="block text-muted-foreground">{c.hint}</span>}
          </span>
        </li>)}
      </ul>}
  </section>;
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try { return parsePreferences(localStorage.getItem(PREFERENCES_KEY)); } catch { return { ...DEFAULT_PREFERENCES }; }
  });
  useEffect(() => { try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch {} }, [preferences]);
  return [preferences, setPreferences] as const;
}

/** One bounded slider with a live value readout. */
function RangeControl({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number; onChange: (v: number) => void;
}) {
  return <div className="space-y-1">
    <div className="flex items-center justify-between">
      <label className="text-sm font-medium">{label}</label>
      <span className="text-xs text-muted-foreground tabular-nums">{value.toFixed(2)}</span>
    </div>
    <input type="range" min={min} max={max} step={0.05} value={value} aria-label={`${label} ${value.toFixed(2)}`}
      onChange={event => onChange(Number(event.target.value))} className="w-full accent-current" />
  </div>;
}

/** Voice picker plus pitch/rate. Lists the voices the engine actually reports, by name and lang. */
function VoiceTuning({ preferences, onChange }: { preferences: Preferences; onChange: (p: Preferences) => void }) {
  const [voices, setVoices] = useState<SpeechVoice[]>(() => listVoices());
  useEffect(() => {
    const refresh = () => setVoices(listVoices());
    refresh();
    const synth = (typeof window === "undefined" ? undefined : (window as unknown as SpeechGlobal).speechSynthesis);
    synth?.addEventListener?.("voiceschanged", refresh);
    return () => synth?.removeEventListener?.("voiceschanged", refresh);
  }, []);
  return <div className="space-y-3">
    <div className="space-y-1">
      <label htmlFor="speak-voice" className="text-sm font-medium">Voice</label>
      <select id="speak-voice" value={preferences.speakVoice ?? ""} onChange={event => onChange({ ...preferences, speakVoice: event.target.value || null })}
        className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <option value="">System default</option>
        {voices.map(v => <option key={v.voiceURI ?? v.name} value={v.voiceURI ?? v.name}>{v.name} · {v.lang}</option>)}
      </select>
      <p className="text-xs text-muted-foreground">{voices.length ? `${voices.length} installed ${voices.length === 1 ? "voice" : "voices"} reported by this engine.` : "No installed voices reported yet; the engine will use its default."}</p>
    </div>
    <RangeControl label="Pitch" value={preferences.speakPitch} min={SPEAK_PITCH_MIN} max={SPEAK_PITCH_MAX} onChange={v => onChange({ ...preferences, speakPitch: v })} />
    <RangeControl label="Rate" value={preferences.speakRate} min={SPEAK_RATE_MIN} max={SPEAK_RATE_MAX} onChange={v => onChange({ ...preferences, speakRate: v })} />
  </div>;
}

export function SettingsWindow({ open, onClose, preferences, onChange, connector }: {
  open: boolean; onClose: () => void; preferences: Preferences; onChange: (p: Preferences) => void; connector: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [capturing, setCapturing] = useState(false);
  const speechIssue = speechDiagnostic();
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else { dialog.current?.close(); setCapturing(false); }
  }, [open]);
  return <dialog ref={dialog} onClose={onClose} aria-labelledby="settings-title" className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50">
    <div className="flex items-center justify-between border-b px-5 py-4">
      <h2 id="settings-title" className="font-semibold">Settings</h2>
      <Button size="icon" variant="ghost" aria-label="Close settings" onClick={onClose}><XIcon className="size-4" /></Button>
    </div>
    <div className="space-y-6 p-5">
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">Voice input</legend>
        {(["hold", "toggle"] as const).map(mode => <label key={mode} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${preferences.voiceMode === mode ? "border-primary bg-muted/50" : ""}`}>
          <input type="radio" name="voice-mode" value={mode} checked={preferences.voiceMode === mode} onChange={() => onChange({ ...preferences, voiceMode: mode })} className="mt-1 accent-current" />
          <span><span className="block text-sm font-medium">{mode === "hold" ? "Hold to talk" : "Toggle to talk"}</span><span className="text-xs text-muted-foreground">{mode === "hold" ? "Record while the mic button or shortcut is held." : "Press once to start, again to stop and transcribe."}</span></span>
        </label>)}
      </fieldset>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Spoken replies</h3>
        {speechIssue ? <p role="note" className="rounded-lg border p-3 text-xs text-muted-foreground">{speechIssue}</p> : <>
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3">
            <span><span className="block text-sm font-medium">Speak replies</span><span className="text-xs text-muted-foreground">Read voice responses and status answers aloud.</span></span>
            <input type="checkbox" checked={preferences.speakReplies} onChange={event => onChange({ ...preferences, speakReplies: event.target.checked })} className="size-4 accent-current" />
          </label>
          {preferences.speakReplies && <div className="rounded-lg border p-3"><VoiceTuning preferences={preferences} onChange={onChange} /></div>}
        </>}
      </section>
      {notificationsSupported() && <section className="space-y-2">
        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3">
          <span><span className="block text-sm font-medium">Desktop alerts</span><span className="text-xs text-muted-foreground">Notify when an agent finishes, loops or grows a big diff.</span></span>
          <input type="checkbox" checked={preferences.notifyAlerts} onChange={event => onChange({ ...preferences, notifyAlerts: event.target.checked })} className="size-4 accent-current" />
        </label>
      </section>}
      <section className="space-y-2">
        <label htmlFor="voice-shortcut" className="text-sm font-medium">Keyboard shortcut</label>
        <div className="flex gap-2">
          <input id="voice-shortcut" readOnly value={capturing ? "Press a key…" : shortcutLabel(preferences.shortcut)} onFocus={() => setCapturing(true)} onBlur={() => setCapturing(false)}
            onKeyDown={event => {
              if (event.code === "Tab" || event.code === "Escape") { setCapturing(false); return; }
              event.preventDefault(); event.stopPropagation();
              if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && validShortcut(event.code)) {
                onChange({ ...preferences, shortcut: event.code }); setCapturing(false); event.currentTarget.blur();
              }
            }} className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-describedby="shortcut-help" />
          <Button variant="outline" onClick={() => onChange({ ...preferences, shortcut: null })}>Disable</Button>
        </div>
        <p id="shortcut-help" className="text-xs leading-relaxed text-muted-foreground">Choose a letter, number, Space, F8 or F9. Works only while Hubert is focused, outside text fields and buttons. Escape cancels recording.</p>
      </section>
      <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground"><span className="font-medium text-foreground">{connector ? `Speech connector: ${connector}` : "No speech connector configured"}</span><p className="mt-1">{connector ? "Recording stops if you leave Hubert or open settings." : "Configure a speech connector using the README before recording."}</p></div>
      <DoctorSection open={open} />
    </div>
    <div className="flex items-center justify-between border-t px-5 py-3">
      <span className="text-xs text-muted-foreground">Saved on this device</span>
      <Button variant="ghost" size="sm" onClick={() => onChange({ ...DEFAULT_PREFERENCES })}>Reset voice settings</Button>
    </div>
  </dialog>;
}
