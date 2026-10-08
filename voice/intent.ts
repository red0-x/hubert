// Turns a transcript into a structured intent. Pure: no I/O, so it is easy to test and safe to run on any text.
export type Intent =
  | { type: "focus"; agent: string }
  | { type: "open"; repo?: string; prompt?: string }
  | { type: "send"; agent: string; text: string }
  | { type: "stop"; agent: string }
  | { type: "status"; agent: string }
  | { type: "diff"; target?: string }
  | { type: "unknown"; text: string };

export type Known = { agents: string[]; repos: string[] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** Best match for a spoken name among candidates. Speech-to-text mangles names ("snail" vs "snake"), so allow one typo per ~4 chars, but never guess between ties. */
export function fuzzy(spoken: string, candidates: string[]): string | null {
  const s = norm(spoken);
  if (!s) return null;
  const scored = candidates.map((c) => ({ c, d: lev(s, norm(c)) })).sort((a, b) => a.d - b.d);
  const best = scored[0];
  if (!best) return null;
  if (best.d === 0) return best.c;
  const limit = Math.floor(norm(best.c).length / 4);
  if (best.d > limit) return null;
  if (scored[1] && scored[1].d === best.d) return null;
  return best.c;
}

const LEAD = /^(?:hey |ok |okay |please |can you |could you |hubert )+/;

/** Speech-to-text artifacts: trailing "please", filler articles before a name, and the same phrase said twice. */
function clean(raw: string): string {
  const sentences = raw.split(/(?<=[.!?,;])\s+/).map(norm).filter(Boolean);
  const first = sentences[0] ?? "";
  const once = sentences.length > 1 && sentences.every((s) => s === first) ? first : sentences.join(" ");
  return once.replace(LEAD, "").replace(/ (?:please|thanks|thank you)$/, "").replace(/^(switch to|focus|go to|jump to|show me|stop|cancel|kill|interrupt) (?:the |agent )+/, "$1 ").replace(/^(.+?) agent$/, "$1");
}

export function parseIntent(raw: string, known: Known): Intent {
  const text = clean(raw);
  const agent = (s: string) => fuzzy(s, known.agents);
  let m: RegExpMatchArray | null;

  if ((m = text.match(/^(?:switch to|focus|go to|show me|jump to)(?: agent)? (.+)$/))) {
    const a = agent(m[1]!);
    if (a) return { type: "focus", agent: a };
  }
  if ((m = text.match(/^(?:tell|ask|message|send) (\w+) (?:to |that )?(.+)$/))) {
    const a = agent(m[1]!);
    if (a) return { type: "send", agent: a, text: m[2]! };
  }
  if ((m = text.match(/^(?:stop|cancel|interrupt|kill) (?:agent )?(.+)$/))) {
    const a = agent(m[1]!);
    if (a) return { type: "stop", agent: a };
  }
  if ((m = text.match(/^what(?: s| is) (.+?) (?:doing|up to)$/)) || (m = text.match(/^status(?: of)? (.+)$/))) {
    const a = agent(m[1]!);
    if (a) return { type: "status", agent: a };
  }
  if ((m = text.match(/^(?:show |open )?(?:the )?diff(?: for| of)?(?: (.+))?$/))) {
    return { type: "diff", target: m[1] ? (fuzzy(m[1], [...known.agents, ...known.repos]) ?? m[1]) : undefined };
  }
  if ((m = text.match(/^(?:open|start|new|spawn)(?: a)?(?: new)?(?: agent)?(?: in (\w+))?(?: (?:and|to) (.+))?$/))) {
    const repo = m[1] ? (fuzzy(m[1], known.repos) ?? undefined) : undefined;
    if (!m[1] || repo) return { type: "open", repo, prompt: m[2] };
  }
  return { type: "unknown", text: raw.trim() };
}

export function describe(i: Intent): string {
  switch (i.type) {
    case "focus": return `Focus ${i.agent}`;
    case "open": return `Open new agent${i.repo ? ` in ${i.repo}` : ""}${i.prompt ? `: ${i.prompt}` : ""}`;
    case "send": return `Tell ${i.agent}: ${i.text}`;
    case "stop": return `Stop ${i.agent}`;
    case "status": return `Status of ${i.agent}`;
    case "diff": return `Show diff${i.target ? ` for ${i.target}` : ""}`;
    case "unknown": return "No matching command";
  }
}
