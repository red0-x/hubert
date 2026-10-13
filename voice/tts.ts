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
  return { sinks: await list("sinks"), sources: await list("sources"), defaultSink: await get("get-default-sink"), defaultSource: await get("get-default-source"), tts: !!Bun.which("espeak-ng") && !!Bun.which("paplay") };
}

/** Make `name` the system default microphone (WebKit records from the default source). */
export async function setDefaultSource(name: string): Promise<boolean> {
  if (!(await audioDevices()).sources.some(s => s.name === name)) return false;
  return (await run(["pactl", "set-default-source", name])) !== null;
}

let current: Proc[] = [];
export function stopTts() { for (const p of current) try { p.kill(); } catch {} current = []; }

/** pitch/rate use the same 0.5..2 scale as the browser API. Unknown sink = default output. */
export async function speakTts(text: string, pitch: number, rate: number, sink: string | null): Promise<boolean> {
  if (!Bun.which("espeak-ng") || !Bun.which("paplay")) return false;
  const device = sink && (await audioDevices()).sinks.some(s => s.name === sink) ? [`--device=${sink}`] : [];
  stopTts();
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 1));
  // en+f5 is espeak's brightest female variant; pitch 0..99 (default 50), speed in wpm (default 175).
  const tts = Bun.spawn(["espeak-ng", "-v", "en-us+f5", "-p", String(Math.round(Math.min(99, clamp(pitch, 0.5, 2) * 50 + 10))), "-s", String(Math.round(175 * clamp(rate, 0.5, 2))), "--stdout", "--", text], { stdout: "pipe", stderr: "ignore" });
  const play = Bun.spawn(["paplay", ...device], { stdin: tts.stdout, stdout: "ignore", stderr: "ignore" });
  current = [tts, play];
  return true;
}
