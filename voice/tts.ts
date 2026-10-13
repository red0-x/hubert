// Spoken replies without browser speech synthesis (WebKitGTK ships none): espeak-ng piped to paplay.
// Also lists/selects PipeWire audio devices via pactl. Argv arrays only, never a shell.
type Dev = { name: string; description: string };
type Proc = ReturnType<typeof Bun.spawn>;

const run = async (argv: string[]) => {
  try { const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" }); const out = await new Response(p.stdout).text(); return (await p.exited) === 0 ? out : null; }
  catch { return null; }
};

export async function audioDevices() {
  const list = async (kind: "sinks" | "sources"): Promise<Dev[]> => {
    try { return (JSON.parse((await run(["pactl", "-f", "json", "list", kind])) ?? "[]") as Dev[]).filter(d => !d.name.endsWith(".monitor")).map(d => ({ name: d.name, description: d.description })); }
    catch { return []; }
  };
  const get = async (k: string) => (await run(["pactl", k]))?.trim() || null;
  return { sinks: await list("sinks"), sources: await list("sources"), defaultSink: await get("get-default-sink"), defaultSource: await get("get-default-source"), tts: !!Bun.which("paplay") && (piperReady() || !!Bun.which("espeak-ng")) };
}

/** Make `name` the system default microphone (WebKit records from the default source). */
export async function setDefaultSource(name: string): Promise<boolean> {
  if (!(await audioDevices()).sources.some(s => s.name === name)) return false;
  return (await run(["pactl", "set-default-source", name])) !== null;
}

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const HOME = join(homedir(), ".local", "share", "hubert");
const PIPER = join(HOME, "tts-venv", "bin", "piper");
/** HUBERT_TTS_VOICE overrides the voice name (file in ~/.local/share/hubert/voices). */
const voiceFile = () => join(HOME, "voices", `${process.env.HUBERT_TTS_VOICE?.replace(/[^\w.-]/g, "") || "en_GB-jenny_dioco-medium"}.onnx`);
const piperReady = () => existsSync(PIPER) && existsSync(voiceFile());

let current: Proc[] = [];
export function stopTts() { for (const p of current) try { p.kill(); } catch {} current = []; }

/** pitch/rate use the same 0.5..2 scale as the browser API. Unknown sink = default output. */
export async function speakTts(text: string, pitch: number, rate: number, sink: string | null): Promise<boolean> {
  if (!Bun.which("paplay") || !(piperReady() || Bun.which("espeak-ng"))) return false;
  const device = sink && (await audioDevices()).sinks.some(s => s.name === sink) ? [`--device=${sink}`] : [];
  stopTts();
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 1));
  if (piperReady()) {
    // Neural voice. Raw s16 mono piped to paplay; playing slightly faster than the model rate lifts pitch for a brighter, younger sound.
    const sr = (JSON.parse(readFileSync(`${voiceFile()}.json`, "utf8")).audio?.sample_rate as number) || 22050;
    const lift = 1 + (clamp(pitch, 0.5, 2) - 1) * 0.3;
    const piper = Bun.spawn([PIPER, "-m", voiceFile(), "--output-raw", "--length-scale", String(1 / clamp(rate, 0.5, 2) / lift)], { stdin: new Blob([text.replace(/\s+/g, " ")]), stdout: "pipe", stderr: "ignore" });
    const play = Bun.spawn(["paplay", "--raw", "--format=s16le", "--channels=1", `--rate=${Math.round(sr * lift)}`, ...device], { stdin: piper.stdout, stdout: "ignore", stderr: "ignore" });
    current = [piper, play];
    return true;
  }
  // en+f5 is espeak's brightest female variant; pitch 0..99 (default 50), speed in wpm (default 175).
  const tts = Bun.spawn(["espeak-ng", "-v", "en-us+f5", "-p", String(Math.round(Math.min(99, clamp(pitch, 0.5, 2) * 50 + 10))), "-s", String(Math.round(175 * clamp(rate, 0.5, 2))), "--stdout", "--", text], { stdout: "pipe", stderr: "ignore" });
  const play = Bun.spawn(["paplay", ...device], { stdin: tts.stdout, stdout: "ignore", stderr: "ignore" });
  current = [tts, play];
  return true;
}
