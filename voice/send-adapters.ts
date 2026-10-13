// Non-interactive send adapters for other agents' CLIs. Each adapter resumes a session and
// feeds it one message, then exits. Commands are pure argv arrays: the message and session id
// are single elements and are never interpolated into a shell string.
//
// Reached only from voice/actions.ts `sendToAgent`, which runs behind the server's confirm gate
// (NEEDS_CONFIRM includes "send" and /api/execute requires `confirmed: true`).
//
// Basis: `claude --help` and `codex --help`/`codex exec resume --help` were read on this machine.
// opencode, pi and omp follow published docs only and have not been run against a real session.
import type { Agent } from "../state";

/** Agents that expose a non-interactive way to add a turn to an existing session. jcode uses the
 *  harness transcript path in actions.ts, cursor exposes no CLI send, so neither is listed here. */
export type SendSource = Exclude<Agent["source"], "jcode" | "cursor">;

/** Each builder returns the argv to resume `id` with `text`. Keep these free of behavior so they stay testable. */
const BUILDERS: Record<SendSource, (id: string, text: string) => string[]> = {
  // `claude -p` prints the reply and exits; `--resume <session-id>` continues that conversation.
  claude: (id, text) => ["claude", "-p", "--resume", id, text],
  // `codex exec resume <uuid> <prompt>` runs the resumed session non-interactively.
  codex: (id, text) => ["codex", "exec", "resume", id, text],
  // `opencode run --session <id> <message>` sends the message and prints the reply without the TUI.
  opencode: (id, text) => ["opencode", "run", "--session", id, text],
  // `pi --print` runs once and exits; `--session <id>` opens the existing session.
  pi: (id, text) => ["pi", "--print", "--session", id, text],
  // `omp --print` runs once and exits; `--resume <id>` resumes the existing session.
  omp: (id, text) => ["omp", "--print", "--resume", id, text],
};

export const SEND_SOURCES = Object.keys(BUILDERS) as SendSource[];

export function canSend(source: Agent["source"]): source is SendSource {
  return source in BUILDERS;
}

/** A session id is one argv element, so a leading "-" would be read as an option by the agent's own CLI. */
export const isSafeSessionId = (id: unknown): id is string =>
  typeof id === "string" && id.trim() !== "" && !id.startsWith("-");

/** Pure. Throws rather than returning a command that could not work. */
export function sendArgv(source: Agent["source"], id: string, text: string): string[] {
  const build = (BUILDERS as Record<string, ((id: string, text: string) => string[]) | undefined>)[source];
  if (!build) throw new Error(`${source} agents expose no non-interactive send`);
  if (!isSafeSessionId(id)) throw new Error("missing or unusable session id");
  if (typeof text !== "string" || !text.trim()) throw new Error("empty message");
  return build(id, text);
}

export type Spawn = (argv: string[], opts: { cwd?: string }) => { unref(): void };

const defaultSpawn: Spawn = (argv, opts) =>
  Bun.spawn(argv, { cwd: opts.cwd, stdio: ["ignore", "ignore", "ignore"] });

/** Fire and forget: the resumed turn can run for minutes, so do not block the request on it. */
export function dispatchSend(
  agent: Pick<Agent, "source" | "id" | "cwd">,
  text: string,
  spawn: Spawn = defaultSpawn,
): string[] {
  const argv = sendArgv(agent.source, agent.id, text);
  spawn(argv, { cwd: agent.cwd || undefined }).unref();
  return argv;
}
