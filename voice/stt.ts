// Speech-to-text connectors. Every connector takes 16 kHz mono WAV bytes and returns text.
// Pick one with HUBERT_STT (see README). All config comes from env so keys never touch the repo.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { tmpdir } from "os";
import { join } from "path";
import { connect } from "net";

type Bytes = Uint8Array<ArrayBuffer>;

export type Connector = {
  id: string;
  label: string;
  kind: "local" | "api";
  /** null when usable, otherwise why not (shown in the UI). */
  unavailable(): string | null;
  transcribe(wav: Bytes): Promise<string>;
};

const env = (k: string) => process.env[k]?.trim() || undefined;
/** HUBERT_STT_SOCKET, else the warm jcode dictation socket if it exists. */
const whisperSocket = () => env("HUBERT_STT_SOCKET") ?? [env("HUBERT_DEFAULT_SOCKET") ?? join(homedir(), ".jcode", "dictation", "whisper.sock")].find(existsSync);
const need = (...keys: string[]) => {
  const miss = keys.filter((k) => !env(k));
  return miss.length ? `set ${miss.join(", ")}` : null;
};

/** OpenAI-compatible /audio/transcriptions. Covers OpenAI, Groq, and local servers (whisper.cpp server, faster-whisper-server, LocalAI, vLLM). */
function openaiCompatible(id: string, label: string, kind: Connector["kind"], base: () => string | undefined, key: () => string | undefined, model: () => string, keyRequired: boolean): Connector {
  return {
    id,
    label,
    kind,
    unavailable: () => (!base() ? "set HUBERT_STT_URL" : keyRequired && !key() ? "missing API key" : null),
    async transcribe(wav) {
      const form = new FormData();
      form.set("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
      form.set("model", model());
      form.set("response_format", "json");
      const res = await fetch(`${base()!.replace(/\/$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: key() ? { authorization: `Bearer ${key()}` } : {},
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`${id} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return ((await res.json()) as { text?: string }).text?.trim() ?? "";
    },
  };
}

const openai = openaiCompatible("openai", "OpenAI", "api", () => env("HUBERT_STT_URL") ?? "https://api.openai.com/v1", () => env("OPENAI_API_KEY"), () => env("HUBERT_STT_MODEL") ?? "gpt-4o-mini-transcribe", true);
const groq = openaiCompatible("groq", "Groq", "api", () => env("HUBERT_STT_URL") ?? "https://api.groq.com/openai/v1", () => env("GROQ_API_KEY"), () => env("HUBERT_STT_MODEL") ?? "whisper-large-v3-turbo", true);
// Any local OpenAI-compatible server. Key optional.
const openaiLocal = openaiCompatible("openai-compatible", "Local OpenAI-compatible server", "local", () => env("HUBERT_STT_URL"), () => env("HUBERT_STT_KEY"), () => env("HUBERT_STT_MODEL") ?? "whisper-1", false);

const deepgram: Connector = {
  id: "deepgram",
  label: "Deepgram",
  kind: "api",
  unavailable: () => need("DEEPGRAM_API_KEY"),
  async transcribe(wav) {
    const model = env("HUBERT_STT_MODEL") ?? "nova-3";
    const res = await fetch(`https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&smart_format=true`, {
      method: "POST",
      headers: { authorization: `Token ${env("DEEPGRAM_API_KEY")}`, "content-type": "audio/wav" },
      body: wav,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`deepgram ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
    return j.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
  },
};

/** Run any local program: HUBERT_STT_COMMAND="whisper-cli -m model.bin -nt -f {wav}". {wav} is replaced by the file path, stdout is the transcript. */
const command: Connector = {
  id: "command",
  label: "Local command",
  kind: "local",
  unavailable: () => need("HUBERT_STT_COMMAND"),
  async transcribe(wav) {
    const dir = mkdtempSync(join(tmpdir(), "hubert-stt-"));
    try {
      const path = join(dir, "audio.wav");
      writeFileSync(path, wav);
      // argv split on whitespace, no shell, so a transcript can never inject commands.
      const argv = env("HUBERT_STT_COMMAND")!.split(/\s+/).map((a) => a.replaceAll("{wav}", path));
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
      const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      if (code !== 0) throw new Error(`command exited ${code}: ${(await new Response(p.stderr).text()).slice(0, 200)}`);
      return out.trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

/** Unix-socket whisper server: write "<wav path>\n", read the transcript until close (the jcode dictation faster-whisper server speaks this). */
const socket: Connector = {
  id: "whisper-socket",
  label: "faster-whisper socket",
  kind: "local",
  unavailable: () => (whisperSocket() ? null : "set HUBERT_STT_SOCKET"),
  async transcribe(wav) {
    const dir = mkdtempSync(join(tmpdir(), "hubert-stt-"));
    try {
      const path = join(dir, "audio.wav");
      writeFileSync(path, wav);
      return await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const s = connect(whisperSocket()!);
        const timer = setTimeout(() => (s.destroy(), reject(new Error("socket timeout"))), 60_000);
        s.on("connect", () => s.write(`F:${path}\n`));
        s.on("data", (d) => chunks.push(Buffer.from(d)));
        s.on("error", (e) => (clearTimeout(timer), reject(e)));
        s.on("close", () => (clearTimeout(timer), resolve(Buffer.concat(chunks).toString("utf8").trim())));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

export const CONNECTORS: Connector[] = [socket, command, openaiLocal, groq, openai, deepgram];

/** HUBERT_STT picks one. Unset: first available local connector, then none (API keys in env are never used implicitly). */
export function activeConnector(): Connector | null {
  const want = env("HUBERT_STT");
  if (want) return CONNECTORS.find((c) => c.id === want) ?? null;
  return CONNECTORS.find((c) => c.kind === "local" && !c.unavailable()) ?? null;
}

/** Browser audio (webm/ogg/mp4) to 16 kHz mono WAV. WAV input passes through. Needs ffmpeg for anything else. */
export async function toWav(audio: Bytes, mime: string): Promise<Bytes> {
  if (mime.includes("wav")) return audio;
  if (!Bun.which("ffmpeg")) throw new Error("ffmpeg is required to convert browser audio (install ffmpeg, or send audio/wav)");
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"], { stdin: new Blob([audio]), stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), p.exited]);
  if (code !== 0) throw new Error(`ffmpeg failed: ${(await new Response(p.stderr).text()).slice(0, 200)}`);
  return new Uint8Array(out);
}

export async function transcribe(audio: Bytes, mime: string): Promise<{ text: string; connector: string }> {
  const c = activeConnector();
  if (!c) throw new Error("no speech-to-text connector configured, see README (HUBERT_STT)");
  const why = c.unavailable();
  if (why) throw new Error(`${c.id} not usable: ${why}`);
  return { text: await c.transcribe(await toWav(audio, mime)), connector: c.id };
}

export function sttStatus() {
  const a = activeConnector();
  return {
    active: a?.id ?? null,
    connectors: CONNECTORS.map((c) => ({ id: c.id, label: c.label, kind: c.kind, unavailable: c.unavailable() })),
  };
}
