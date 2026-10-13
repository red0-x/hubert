import { useEffect, useState } from "react";

const SIZE = 56;
type Point = { x: number; y: number };
export const clamp = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
export const bounds = (p: Point, width: number, height: number) => ({
  x: Math.round(clamp(p.x) * Math.max(0, width - Math.min(SIZE, width))),
  y: Math.round(clamp(p.y) * Math.max(0, height - Math.min(SIZE, height))),
});

export type MascotState = "idle" | "listening" | "thinking" | "speaking" | "error";

/** Every pose we look for under /mascot/<state>.png. */
export const MASCOT_STATES: MascotState[] = ["idle", "listening", "thinking", "speaking", "error"];

/** How long a completed voice answer keeps Hubert in the `speaking` pose. */
export const ANSWER_MS = 2500;

export type MascotInput = {
  stale?: boolean;
  error?: boolean;
  /** VoiceState from recording.ts: idle | starting | listening | transcribing */
  voice?: string;
  /** A voice request is in flight (recording done, awaiting plan). */
  thinking?: boolean;
  /** Timestamp of the last handled request, if any. */
  answeredAt?: number;
  now: number;
};

/** Resolve one mascot pose from app signals. Error beats thinking beats listening beats speaking. */
export function mascotState({ stale, error, voice, thinking, answeredAt, now }: MascotInput): MascotState {
  if (error || stale) return "error";
  if (thinking || voice === "transcribing") return "thinking";
  if (voice === "listening" || voice === "starting") return "listening";
  if (answeredAt && now - answeredAt >= 0 && now - answeredAt < ANSWER_MS) return "speaking";
  return "idle";
}

export const mascotSrc = (state: MascotState) => `/mascot/${state}.png`;

// Startup probe result per state, cached for the session so each sprite is HEAD-checked once.
const available = new Map<MascotState, boolean>();

/** HEAD-check one sprite once and remember the answer. */
export async function hasMascotSprite(state: MascotState, fetcher: typeof fetch = fetch): Promise<boolean> {
  const cached = available.get(state);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    ok = (await fetcher(mascotSrc(state), { method: "HEAD" })).ok;
  } catch { ok = false; }
  available.set(state, ok);
  return ok;
}

/** Test hook: forget cached probe results. */
export const resetMascotCache = () => available.clear();

/**
 * Optional sprite-ready character. Renders a small static image next to the mic only when
 * /mascot/<state>.png exists (probed once at startup); otherwise renders nothing. No roam, drag or float.
 */
export function MascotCharacter({ state = "idle" }: { state?: MascotState }) {
  const [ready, setReady] = useState<MascotState[]>([]);
  useEffect(() => {
    let live = true;
    Promise.all(MASCOT_STATES.map(async (s) => ((await hasMascotSprite(s)) ? s : null)))
      .then((found) => { if (live) setReady(found.filter((s): s is MascotState => s !== null)); });
    return () => { live = false; };
  }, []);
  if (!ready.includes(state)) return null;
  return <img src={mascotSrc(state)} alt="" data-state={state} className="hubert-character" draggable={false} />;
}
