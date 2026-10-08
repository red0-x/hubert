import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEFAULT_PREFERENCES, parsePreferences, PREFERENCES_KEY, shortcutLabel, validShortcut, type Preferences } from "./preferences";

export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try { return parsePreferences(localStorage.getItem(PREFERENCES_KEY)); } catch { return { ...DEFAULT_PREFERENCES }; }
  });
  useEffect(() => { try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch {} }, [preferences]);
  return [preferences, setPreferences] as const;
}

export function SettingsWindow({ open, onClose, preferences, onChange, connector }: {
  open: boolean; onClose: () => void; preferences: Preferences; onChange: (p: Preferences) => void; connector: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [capturing, setCapturing] = useState(false);
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
    </div>
    <div className="flex items-center justify-between border-t px-5 py-3">
      <span className="text-xs text-muted-foreground">Saved on this device</span>
      <Button variant="ghost" size="sm" onClick={() => onChange({ ...DEFAULT_PREFERENCES })}>Reset voice settings</Button>
    </div>
  </dialog>;
}
