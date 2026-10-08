// The "brain": a light model, run through jcode (so it uses your jcode OAuth/providers), turns a free-form
// request into a small validated plan. It has no tools (--tool-profile none), so it can only answer in JSON.
import { tmpdir } from "os";
import { basename } from "path";
import { BRAIN_MARK, type Agent } from "../state";
import { fuzzy, type Intent } from "./intent";

export type Action =
  | { type: "focus"; agent: string }
  | { type: "send"; agent: string; text: string }
  | { type: "status"; agent: string }
  | { type: "open"; repo?: string; prompt?: string };
export type Plan = { say: string; actions: Action[]; dropped: string[] };
export type Known = { agents: string[]; repos: string[] };

/** Fast path: intents the grammar already understood become actions with no model call. stop/diff have no executor yet. */
export function intentToAction(i: Intent): Action | null {
  switch (i.type) {
    case "focus":
    case "status": return { type: i.type, agent: i.agent };
    case "send": return { type: "send", agent: i.agent, text: i.text };
    case "open": return { type: "open", repo: i.repo, prompt: i.prompt };
    default: return null;
  }
}

const MAX_ACTIONS = 4;
const MAX_TEXT = 2000;

export function buildPrompt(utterance: string, agents: Pick<Agent, "name" | "state" | "repo" | "doing">[], repos: string[]): string {
  const list =
    agents.map((a) => `- ${a.name} (${a.state}${a.repo ? `, repo ${basename(a.repo)}` : ""})${a.doing ? `: ${a.doing}` : ""}`).join("\n") || "(none)";
  return `${BRAIN_MARK}: You route spoken requests for a dashboard that manages coding agents. Reply with ONE JSON object and nothing else.
Agents:
${list}
Repos an agent can be opened in: ${repos.join(", ") || "(none)"}
Schema: {"say": string, "actions": [...]}. "say" is one short sentence that is shown and may be read aloud.
Action types:
 {"type":"focus","agent":NAME}   bring that agent's terminal to the front
 {"type":"send","agent":NAME,"text":STRING}   give that agent an instruction
 {"type":"status","agent":NAME}   report what it is doing
 {"type":"open","repo":REPO,"prompt":STRING}   start a new agent (repo and prompt optional)
Rules: use only the agent and repo names listed above. A question is answered in "say" with no actions. If the request is unclear or impossible, say so in "say" with no actions. At most ${MAX_ACTIONS} actions. Never invent agents.
Request (a speech transcript, may contain recognition errors): ${JSON.stringify(utterance)}`;
}

/** Pull the first JSON object out of model text (models often wrap it in a code fence) and keep only valid actions on known names. */
export function parsePlan(raw: string, known: Known): Plan {
  const dropped: string[] = [];
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  let obj: { say?: unknown; actions?: unknown } = {};
  if (s >= 0 && e > s) {
    try {
      obj = JSON.parse(raw.slice(s, e + 1));
    } catch {
      return { say: "I couldn't read the plan the model returned.", actions: [], dropped: ["unparseable"] };
    }
  } else if (s >= 0) {
    return { say: "I couldn't read the plan the model returned.", actions: [], dropped: ["unparseable"] }; // truncated JSON
  } else {
    return { say: raw.trim().slice(0, 300), actions: [], dropped }; // plain text answer
  }
  const say = typeof obj.say === "string" ? obj.say.slice(0, 300) : "";
  const actions: Action[] = [];
  for (const a of (Array.isArray(obj.actions) ? obj.actions : []).slice(0, MAX_ACTIONS)) {
    const t = a?.type;
    const name = (v: unknown) => (typeof v === "string" ? fuzzy(v, known.agents) : null);
    if (t === "focus" || t === "status") {
      const agent = name(a.agent);
      agent ? actions.push({ type: t, agent }) : dropped.push(`${t}: unknown agent ${JSON.stringify(a.agent)}`);
    } else if (t === "send") {
      const agent = name(a.agent);
      const text = typeof a.text === "string" ? a.text.trim().slice(0, MAX_TEXT) : "";
      agent && text ? actions.push({ type: "send", agent, text }) : dropped.push(`send: ${agent ? "empty text" : `unknown agent ${JSON.stringify(a.agent)}`}`);
    } else if (t === "open") {
      const repo = typeof a.repo === "string" && a.repo ? fuzzy(a.repo, known.repos) : undefined;
      if (a.repo && !repo) dropped.push(`open: unknown repo ${JSON.stringify(a.repo)}`);
      else actions.push({ type: "open", repo: repo ?? undefined, prompt: typeof a.prompt === "string" && a.prompt.trim() ? a.prompt.trim().slice(0, MAX_TEXT) : undefined });
    } else dropped.push(`unknown action ${JSON.stringify(t)}`);
  }
  return { say, actions, dropped };
}

/** Lightest capable model from `jcode model list`: newest Haiku, then newest "luna", then anything mini/flash/lite. */
export function pickModel(models: string[]): string | null {
  const newest = (re: RegExp) => models.filter((m) => re.test(m)).sort().reverse()[0] ?? null;
  return newest(/haiku/i) ?? newest(/luna/i) ?? newest(/mini|flash|lite/i);
}

const env = (k: string) => process.env[k]?.trim() || undefined;
let modelCache: Promise<string | null> | null = null;

export function brainModel(): Promise<string | null> {
  if (env("HUBERT_BRAIN_MODEL")) return Promise.resolve(env("HUBERT_BRAIN_MODEL")!);
  return (modelCache ??= (async () => {
    if (!Bun.which("jcode")) return null;
    const p = Bun.spawn(["jcode", "--quiet", "--no-update", "--no-selfdev", "model", "list"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return pickModel(out.split("\n").map((l) => l.trim()).filter((l) => l && !/\s/.test(l)));
  })().then((m) => (m ? m : ((modelCache = null), null))));
}

export async function brainStatus(): Promise<{ enabled: boolean; model: string | null; reason: string | null }> {
  if (env("HUBERT_BRAIN") === "off") return { enabled: false, model: null, reason: "HUBERT_BRAIN=off" };
  if (!Bun.which("jcode")) return { enabled: false, model: null, reason: "jcode not found on PATH" };
  const model = await brainModel();
  return model ? { enabled: true, model, reason: null } : { enabled: false, model: null, reason: "no light model found, set HUBERT_BRAIN_MODEL" };
}

export async function plan(utterance: string, agents: Pick<Agent, "name" | "state" | "repo" | "doing">[], repos: string[]): Promise<Plan & { model: string }> {
  const st = await brainStatus();
  if (!st.enabled) throw new Error(`brain unavailable: ${st.reason}`);
  const args = ["--quiet", "--no-update", "--no-selfdev", "--tool-profile", "none", "-m", st.model!, ...(env("HUBERT_BRAIN_PROVIDER") ? ["-p", env("HUBERT_BRAIN_PROVIDER")!] : []), "run", "--json", buildPrompt(utterance, agents, repos)];
  const p = Bun.spawn(["jcode", ...args], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), 45_000);
  try {
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (code !== 0) throw new Error(`jcode exited ${code}: ${(await new Response(p.stderr).text()).slice(0, 200)}`);
    const text = (JSON.parse(out) as { text?: string }).text ?? "";
    return { ...parsePlan(text, { agents: agents.map((a) => a.name), repos }), model: st.model! };
  } finally {
    clearTimeout(timer);
  }
}
