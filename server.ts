import { collect } from "./state";
import { editEvents, fileDiff, recentCommands } from "./live";
import { commandStats } from "./command-stats";
import { sttStatus, transcribe } from "./voice/stt";
import { answer, brainStatus, intentToAction, plan, type Action } from "./voice/brain";
import { NEEDS_CONFIRM, execute, listWindows } from "./voice/actions";
import { describe, parseIntent } from "./voice/intent";
import { isPttAction, resolvePtt, type PttState } from "./voice/ptt";
import { ensureClientBundle, type Client } from "./client-build";
import { buildReport, realEnv } from "./doctor";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

// Production serves a prebuilt, minified client from a disk cache (see client-build.ts),
// so a cold start does not bundle anything. Development (or a failed prebuild) keeps
// Bun's HMR pipeline: the imported HTMLBundle is what Bun.serve wants as a route value,
// so it is only loaded when it is actually needed.
const client: Client | null = process.env.NODE_ENV === "production" ? await ensureClientBundle() : null;
const devIndex: Route | null = client ? null : ((await import("./src/index.html")).default as unknown as Route);

const PORT = Number(process.env.HUBERT_PORT ?? 7777);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// argv used to run a command in a new terminal window, first one found on PATH wins.
const TERMINALS: Record<string, string[]> = {
  kitty: ["kitty"],
  ghostty: ["ghostty", "-e"],
  foot: ["foot"],
  alacritty: ["alacritty", "-e"],
  wezterm: ["wezterm", "start", "--"],
  "gnome-terminal": ["gnome-terminal", "--"],
  konsole: ["konsole", "-e"],
  xterm: ["xterm", "-e"],
};

function terminal(): string[] | null {
  if (process.env.HUBERT_TERMINAL) return process.env.HUBERT_TERMINAL.split(/\s+/);
  for (const [bin, argv] of Object.entries(TERMINALS)) if (Bun.which(bin)) return argv;
  return null;
}

// Local-only API: block DNS-rebinding (Host) and cross-site requests (Origin).
export function guard(req: Request, allowedHosts: Set<string> = ALLOWED_HOSTS): Response | null {
  if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("bad host", { status: 403 });
  const origin = req.headers.get("origin");
  if (origin && !allowedHosts.has(new URL(origin).host)) return new Response("bad origin", { status: 403 });
  return null;
}

// Optional sprite PNGs live in ./mascot (gitignored, except its README). Flat filenames only.
export const MASCOT_DIR = "./mascot";
const MASCOT_TYPES: Record<string, string> = { png: "image/png", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };

/** Serve /mascot/<name>. Rejects traversal, separators and non-image names before touching disk. */
export function mascotRoute(req: Request): Response {
  const denied = guard(req);
  if (denied) return denied;
  let name: string;
  try { name = decodeURIComponent(new URL(req.url).pathname.slice("/mascot/".length)); }
  catch { return new Response("bad mascot path", { status: 400 }); }
  const match = /^([A-Za-z0-9_-]+)\.(png|webp|gif|svg)$/.exec(name);
  if (!match) return new Response("bad mascot path", { status: 400 });
  const file = Bun.file(`${MASCOT_DIR}/${match[0]}`);
  if (!file.size) return new Response("not found", { status: 404 });
  return new Response(file, { headers: { "content-type": MASCOT_TYPES[match[2]!] ?? "application/octet-stream" } });
}

export type Route = (req: Request) => Response | Promise<Response>;
export type RouteTable = Record<string, Route | Partial<Record<string, Route>>>;

/** Minimal router mirroring Bun's route semantics, so handlers can be tested without binding a port. */
export function dispatch(routes: RouteTable, req: Request): Response | Promise<Response> {
  const entry = routes[new URL(req.url).pathname];
  if (!entry) return new Response("not found", { status: 404 });
  if (typeof entry === "function") return entry(req);
  const method = req.method.toUpperCase();
  const fn = entry[method] ?? (method === "HEAD" ? entry.GET : undefined);
  if (!fn) return new Response("method not allowed", { status: 405 });
  return fn(req);
}

/** Injectable data sources so route handlers stay testable without touching the real machine. */
export type Deps = {
  collect: typeof collect;
  recentCommands: typeof recentCommands;
  commandStats: typeof commandStats;
  editEvents: typeof editEvents;
  fileDiff: typeof fileDiff;
  sttStatus: typeof sttStatus;
  transcribe: typeof transcribe;
  brainStatus: typeof brainStatus;
  intentToAction: typeof intentToAction;
  plan: typeof plan;
  describe: typeof describe;
  parseIntent: typeof parseIntent;
  listWindows: typeof listWindows;
  execute: typeof execute;
  needsConfirm: Set<Action["type"]>;
};

export const defaultDeps: Deps = {
  collect, recentCommands, commandStats, editEvents, fileDiff, sttStatus, transcribe,
  brainStatus, intentToAction, plan, describe, parseIntent, listWindows, execute,
  needsConfirm: NEEDS_CONFIRM,
};

export async function diffRoute(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const root = params.get("root") ?? "";
  const file = params.get("file") ?? "";
  if (!(await deps.collect()).repos.some((r) => r.root === root && r.files.some((f) => f.path === file)))
    return new Response("unknown changed file", { status: 400 });
  try { return new Response(deps.fileDiff(root, file).slice(0, 200_000), { headers: { "content-type": "text/plain; charset=utf-8" } }); }
  catch (e) { return new Response((e as Error).message, { status: 400 }); }
}

export async function transcribeRoute(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  const mime = req.headers.get("content-type") ?? "";
  if (!mime.startsWith("audio/")) return new Response("expected audio/*", { status: 415 });
  const audio = new Uint8Array(await req.arrayBuffer());
  if (!audio.length || audio.length > MAX_AUDIO_BYTES) return new Response("audio empty or over 10 MB", { status: 413 });
  try {
    return Response.json(await deps.transcribe(audio, mime));
  } catch (e) {
    return new Response((e as Error).message, { status: 502 });
  }
}

export async function executeRoute(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  const { action, confirmed } = (await req.json().catch(() => ({}))) as { action?: Action; confirmed?: boolean };
  if (!action || typeof action !== "object") return new Response("action required", { status: 400 });
  // Re-validate against live state: never trust the client's names.
  const s = await deps.collect();
  const live = s.agents.filter((a) => a.state === "working" || a.state === "idle").map((a) => a.name);
  if ("agent" in action && !live.includes(action.agent)) return new Response(`unknown agent ${String(action.agent)}`, { status: 400 });
  if (action.type === "send" && (typeof action.text !== "string" || !action.text.trim() || action.text.length > 2000)) return new Response("bad text", { status: 400 });
  if (!["focus", "send", "status", "stop", "move", "resize"].includes(action.type)) return new Response("unsupported action", { status: 400 });
  if (deps.needsConfirm.has(action.type) && confirmed !== true) return new Response("this action needs confirmed: true", { status: 409 });
  try {
    return Response.json({ result: await deps.execute(action) });
  } catch (e) {
    return new Response((e as Error).message, { status: 422 });
  }
}

// Global push-to-talk: the CLI (`hubert.sh ptt …`) drives the state, the window follows it over SSE.
let ptt: PttState = "idle";
const pttClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const pttFrame = (data: string) => new TextEncoder().encode(`data: ${data}\n\n`);
function pttBroadcast() {
  for (const client of pttClients) { try { client.enqueue(pttFrame(ptt)); } catch { pttClients.delete(client); } }
}
setInterval(() => { for (const client of pttClients) { try { client.enqueue(new TextEncoder().encode(": ping\n\n")); } catch { pttClients.delete(client); } } }, 15000).unref();

export const routes: RouteTable = {
    "/": client ? () => client.index() : (devIndex as unknown as Route),
    "/_client/*": (req) => client?.asset(new URL(req.url).pathname) ?? new Response("not found", { status: 404 }),
    "/mascot/*": (req) => mascotRoute(req),
    "/docs/logo.png": (req) => guard(req) ?? new Response(Bun.file("./docs/logo.png"), { headers: { "content-type": "image/png" } }),
    "/api/state": async (req) => guard(req) ?? Response.json(await collect()),
    "/api/commands": (req) => guard(req) ?? Response.json(recentCommands()),
    "/api/command-stats": (req) => guard(req) ?? Response.json(commandStats(recentCommands())),
    "/api/edits": async (req) => guard(req) ?? Response.json(editEvents((await collect()).repos)),
    "/api/diff": (req) => diffRoute(req),
    "/api/stt": (req) => guard(req) ?? Response.json(sttStatus()),
    // First-run health check: which tools/connectors/dirs are present and what to do about gaps.
    "/api/doctor": (req) => guard(req) ?? Response.json(buildReport(realEnv(PORT))),
    // Global hotkey entry point. The CLI POSTs start/stop/toggle and every open window reacts over SSE.
    "/api/ptt": {
      POST: async (req) => {
        const denied = guard(req);
        if (denied) return denied;
        const { action } = (await req.json().catch(() => ({}))) as { action?: unknown };
        if (!isPttAction(action)) return new Response("action must be start, stop or toggle", { status: 400 });
        ptt = resolvePtt(ptt, action);
        pttBroadcast();
        return Response.json({ state: ptt });
      },
    },
    "/api/ptt/events": (req) => {
      const denied = guard(req);
      if (denied) return denied;
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) { ctrl = c; pttClients.add(c); c.enqueue(pttFrame(ptt)); },
        cancel() { pttClients.delete(ctrl); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
    "/api/transcribe": {
      POST: (req) => transcribeRoute(req),
    },
    "/api/voice": {
      GET: async (req) => guard(req) ?? Response.json(await brainStatus()),
      // Transcript in, plan out. Grammar first (instant, free), light model for anything else. Nothing is executed here.
      POST: async (req) => {
        const denied = guard(req);
        if (denied) return denied;
        const { text } = (await req.json().catch(() => ({}))) as { text?: string };
        if (!text?.trim() || text.length > 2000) return new Response("text required (max 2000 chars)", { status: 400 });
        const started = Date.now();
        const ms = () => Date.now() - started;
        const s = await collect();
        const live = s.agents.filter((a) => a.state === "working" || a.state === "idle");
        const known = { agents: live.map((a) => a.name), repos: s.repos.map((r) => r.name) };
        const intent = parseIntent(text, known);
        // Read-only questions become a spoken reply and view switches become a client-side directive. No model, no mutation.
        const ans = answer(intent, { agents: live, repos: s.repos.map((r) => ({ name: r.name, files: r.files })) }, recentCommands());
        if (ans) return Response.json({ say: ans.say, actions: [], dropped: [], view: ans.view, via: "grammar", ms: ms() });
        const act = intentToAction(intent);
        const windows = listWindows();
        const withFlags = (actions: Action[]) => actions.map((a) => ({ ...a, needsConfirm: NEEDS_CONFIRM.has(a.type), ...("address" in a ? { targetTitle: windows.find(w => w.address === a.address)?.title ?? "Window unavailable" } : {}) }));
        if (act) return Response.json({ say: describe(intent), actions: withFlags([act]), dropped: [], via: "grammar", ms: ms() });
        try {
          const p = await plan(text, live, known.repos, windows);
          return Response.json({ say: p.say, actions: withFlags(p.actions), dropped: p.dropped, via: p.model, ms: ms() });
        } catch (e) {
          return new Response((e as Error).message, { status: 502 });
        }
      },
    },
    "/api/execute": {
      POST: (req) => executeRoute(req),
    },
    "/api/lazygit": {
      POST: async (req) => {
        const denied = guard(req);
        if (denied) return denied;
        const { root } = (await req.json().catch(() => ({}))) as { root?: string };
        // only open repos we are currently reporting, never arbitrary paths
        if (!root || !(await collect()).repos.some((r) => r.root === root)) return new Response("unknown repo", { status: 400 });
        if (!Bun.which("lazygit")) return new Response("lazygit not installed", { status: 501 });
        const term = terminal();
        if (!term) return new Response("no terminal found, set HUBERT_TERMINAL", { status: 501 });
        Bun.spawn([...term, "lazygit"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] }).unref();
        return new Response("ok");
      },
    },
  };

if (import.meta.main) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    development: process.env.NODE_ENV !== "production",
    routes,
  });
  console.log(`hubert on ${server.url}`);
}
