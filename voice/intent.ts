// Turns a transcript into a structured intent. Pure: no I/O, so it is easy to test and safe to run on any text.
export type Panel = "agents" | "map" | "commands" | "diff";

/** A change the browser can make to its own view with no server action and no confirmation. */
export type ViewDirective = { panel?: Panel; repo?: string; failuresOnly?: boolean };

export type Intent =
  | { type: "focus"; agent: string }
  | { type: "send"; agent: string; text: string }
  | { type: "stop"; agent: string }
  | { type: "status"; agent: string }
  | { type: "diff"; target?: string }
  | { type: "roster"; state: "working" | "idle" }
  | { type: "changed"; repo?: string }
  | { type: "failures" }
  | { type: "view"; panel?: Panel; repo?: string }
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

/**
 * Rough sound-alike key so homophones whisper often produces ("hoarse" for "horse", "lamma" for "llama")
 * still match even when the edit distance is too large. Drop vowels, fold common consonant digraphs,
 * collapse doubled letters and a trailing plural "s".
 */
export function phonetic(spoken: string): string {
  return spoken.toLowerCase().replace(/[^a-z]/g, "")
    .replace(/ph/g, "f").replace(/gh/g, "g").replace(/ck/g, "k").replace(/qu/g, "k")
    .replace(/x/g, "ks").replace(/c/g, "k")
    .replace(/[aeiouy]/g, "")
    .replace(/(.)\1+/g, "$1")
    .replace(/s$/, "");
}

/** Best match for a spoken name among candidates. Speech-to-text mangles names ("snail" vs "snake"), so allow one typo per ~4 chars, then fall back to a phonetic key, but never guess between ties. */
export function fuzzy(spoken: string, candidates: string[]): string | null {
  const s = norm(spoken);
  if (!s) return null;
  const scored = candidates.map((c) => ({ c, d: lev(s, norm(c)) })).sort((a, b) => a.d - b.d);
  const best = scored[0];
  if (!best) return null;
  if (best.d === 0) return best.c;
  const limit = Math.floor(norm(best.c).length / 4);
  if (best.d <= limit) return scored[1] && scored[1].d === best.d ? null : best.c;
  const key = phonetic(s);
  if (!key) return null;
  const sounds = candidates.filter((c) => phonetic(norm(c)) === key);
  return sounds.length === 1 ? sounds[0]! : null;
}

const LEAD = /^(?:hey |ok |okay |please |can you |could you |hubert )+/;

/** Speech-to-text artifacts: trailing "please", filler articles before a name, and the same phrase said twice. */
function clean(raw: string): string {
  const sentences = raw.split(/(?<=[.!?,;])\s+/).map(norm).filter(Boolean);
  const first = sentences[0] ?? "";
  const once = sentences.length > 1 && sentences.every((s) => s === first) ? first : sentences.join(" ");
  return once
    .replace(/\bwhats\b/g, "what s") // whisper drops the apostrophe in "what's"
    .replace(LEAD, "")
    .replace(/ (?:please|thanks|thank you)$/, "")
    .replace(/^(switch to|focus|go to|jump to|show me|stop|cancel|kill|interrupt|tell|ask) on /, "$1 ")
    .replace(/^(switch to|focus|go to|jump to|show me|stop|cancel|kill|interrupt) (?:the |agent )+/, "$1 ")
    .replace(/^(.+?) agent$/, "$1");
}

const asState = (word: string): "working" | "idle" => (/idle/.test(word) ? "idle" : "working");
const PANEL = (word: string): Panel =>
  /agent/.test(word) ? "agents" : /map/.test(word) ? "map" : /command/.test(word) ? "commands" : "diff";

const ROSTER = [
  /^(?:which |what |how many )?(?:agents?|sessions?)(?: are| is)? (working|idle|running|busy|active)$/,
  /^(?:who|who s)(?: is| are)? (working|idle|running|busy|active)(?: right now| now| at the moment)?$/,
  /^(?:show|list)(?: me)? (?:the )?(working|idle|running|busy|active) agents$/,
  /^(?:show|list)(?: me)? (?:which |what )?(?:agents?|sessions?)(?: are| is)? (working|idle|running|busy|active)$/,
  /^(?:are|is) (?:any|the) agents? (working|idle|running|busy)$/,
  /^(working|idle) agents$/,
];

const FAILURES = [
  /^(?:show|list|see|any)? ?(?:me )?(?:the )?(?:failing|failed|broken|erroring|error) (?:commands?|bash|tests?|jobs?|builds?)$/,
  /^(?:show|list|see|any)? ?(?:me )?(?:the )?(?:failures|errors|fails)$/,
  /^(?:what|which) (?:commands?|tests?|jobs?)? ?(?:are )?(?:failed|failing|broke|broken)$/,
  /^what (?:commands?|tests?) (?:failed|are failing)$/,
];

const VIEW = /^(?:switch to|go to|open|show|show me|pull up) (?:the )?(agents|agent list|map|change map|commands|command list|diff|live diff|diffs)(?: (?:panel|view|tab|list))?$/;

export function parseIntent(raw: string, known: Known): Intent {
  const text = clean(raw);
  const agent = (s: string) => fuzzy(s, known.agents);
  const repo = (s: string) => fuzzy(s, known.repos);
  let m: RegExpMatchArray | null;

  // Questions about the world. Answered with text, no model, no action.
  for (const re of ROSTER)
    if ((m = text.match(re))) return { type: "roster", state: asState(m[1]!) };

  if ((m = text.match(/^what(?: s| has| have)? changed(?: in| for)?(?: the)?(?: (.+?))?(?: repo)?$/)))
    return m[1] ? (repo(m[1]) ? { type: "changed", repo: repo(m[1])! } : { type: "unknown", text: raw.trim() }) : { type: "changed" };

  if (FAILURES.some((re) => re.test(text))) return { type: "failures" };

  // View-only commands the browser runs itself: switch panel, select a repo.
  if ((m = text.match(/^(?:select|switch to|go to|show|open|focus) (?:the )?repo(?:sitory)? (?:to |for )?(.+)$/)) || (m = text.match(/^(?:select|switch to|go to|show|open) (?:the )?(.+?) repo(?:sitory)?$/))) {
    const r = repo(m[1]!);
    return r ? { type: "view", repo: r } : { type: "unknown", text: raw.trim() };
  }
  if ((m = text.match(VIEW))) return { type: "view", panel: PANEL(m[1]!) };

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
  if ((m = text.match(/^what(?: s| is) (.+?) (?:doing|up to|working on)$/)) || (m = text.match(/^status(?: of| for)? (.+)$/)) || (m = text.match(/^how(?: s| is) (.+?) (?:doing|going)$/))) {
    const a = agent(m[1]!);
    if (a) return { type: "status", agent: a };
  }
  if ((m = text.match(/^(?:show |open )?(?:the )?diff(?: for| of)?(?: (.+))?$/)))
    return { type: "diff", target: m[1] ? (fuzzy(m[1], [...known.agents, ...known.repos]) ?? m[1]) : undefined };
  return { type: "unknown", text: raw.trim() };
}

export function describe(i: Intent): string {
  switch (i.type) {
    case "focus": return `Focus ${i.agent}`;
    case "send": return `Tell ${i.agent}: ${i.text}`;
    case "stop": return `Stop ${i.agent}`;
    case "status": return `Status of ${i.agent}`;
    case "diff": return `Show diff${i.target ? ` for ${i.target}` : ""}`;
    case "roster": return `Show ${i.state} agents`;
    case "changed": return i.repo ? `What changed in ${i.repo}` : "What changed";
    case "failures": return "Show failing commands";
    case "view": return i.repo ? `Show repo ${i.repo}` : `Show ${i.panel ?? "view"}`;
    case "unknown": return "No matching command";
  }
}
