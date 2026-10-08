import index from "./src/index.html";
import { collect } from "./state";
import { sttStatus, transcribe } from "./voice/stt";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

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
function guard(req: Request): Response | null {
  if (!ALLOWED_HOSTS.has(req.headers.get("host") ?? "")) return new Response("bad host", { status: 403 });
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_HOSTS.has(new URL(origin).host)) return new Response("bad origin", { status: 403 });
  return null;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": index,
    "/api/state": (req) => guard(req) ?? Response.json(collect()),
    "/api/stt": (req) => guard(req) ?? Response.json(sttStatus()),
    "/api/transcribe": {
      POST: async (req) => {
        const denied = guard(req);
        if (denied) return denied;
        const mime = req.headers.get("content-type") ?? "";
        if (!mime.startsWith("audio/")) return new Response("expected audio/*", { status: 415 });
        const audio = new Uint8Array(await req.arrayBuffer());
        if (!audio.length || audio.length > MAX_AUDIO_BYTES) return new Response("audio empty or over 10 MB", { status: 413 });
        try {
          return Response.json(await transcribe(audio, mime));
        } catch (e) {
          return new Response((e as Error).message, { status: 502 });
        }
      },
    },
    "/api/lazygit": {
      POST: async (req) => {
        const denied = guard(req);
        if (denied) return denied;
        const { root } = (await req.json().catch(() => ({}))) as { root?: string };
        // only open repos we are currently reporting, never arbitrary paths
        if (!root || !collect().repos.some((r) => r.root === root)) return new Response("unknown repo", { status: 400 });
        if (!Bun.which("lazygit")) return new Response("lazygit not installed", { status: 501 });
        const term = terminal();
        if (!term) return new Response("no terminal found, set HUBERT_TERMINAL", { status: 501 });
        Bun.spawn([...term, "lazygit"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] }).unref();
        return new Response("ok");
      },
    },
  },
});

console.log(`hubert on ${server.url}`);
