export type PttState = "idle" | "recording";
export type PttAction = "start" | "stop" | "toggle";

/** The server is the authority for the global hotkey so `toggle` can flip whatever the CLI sent. Idempotent. */
export function resolvePtt(current: PttState, action: PttAction): PttState {
  if (action === "start") return "recording";
  if (action === "stop") return "idle";
  return current === "recording" ? "idle" : "recording";
}

export function isPttAction(value: unknown): value is PttAction {
  return value === "start" || value === "stop" || value === "toggle";
}
