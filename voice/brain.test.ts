import { expect, test } from "bun:test";
import { answer, buildPrompt, intentToAction, parsePlan, pickModel, spokenChanges, spokenFailures, spokenRoster, spokenStatus } from "./brain";
import { findPane, windowCommand } from "./actions";
import type { Agent } from "../state";

test("answer: status, roster, changed, failures and view, all without a model", () => {
  const state: { agents: Pick<Agent, "name" | "state" | "repo" | "doing">[]; repos: { name: string; files: { path: string; add: number; del: number }[] }[] } = {
    agents: [
      { name: "snake", state: "working", repo: "/home/red/ecily", doing: "bash: bun test" },
      { name: "llama", state: "idle", repo: null, doing: undefined },
    ],
    repos: [
      { name: "ecily", files: [{ path: "src/nav.tsx", add: 40, del: 2 }] },
      { name: "hubert", files: [] },
    ],
  };
  const cmds = [{ agent: "snake", command: "bun test", ok: false }, { agent: "llama", command: "ls", ok: true }];

  expect(answer({ type: "status", agent: "snake" }, state, cmds)).toEqual({ say: "snake is working in ecily, last bash." });
  expect(answer({ type: "status", agent: "ghost" }, state, cmds)).toEqual({ say: "I don't see an agent called ghost." });
  expect(answer({ type: "roster", state: "working" }, state, cmds)).toEqual({ say: "1 agent is working: snake." });
  expect(answer({ type: "changed", repo: "ecily" }, state, cmds)).toEqual({ say: "ecily has 1 changed file, plus 40 minus 2. Biggest: src/nav.tsx." });
  expect(answer({ type: "changed", repo: "hubert" }, state, cmds)).toEqual({ say: "hubert has no changes." });
  expect(answer({ type: "changed", repo: "ghost" }, state, cmds)).toEqual({ say: "I don't see a repo called ghost." });
  expect(answer({ type: "changed" }, state, cmds)).toEqual({ say: "ecily has 1 changed file, plus 40 minus 2. Biggest: src/nav.tsx." });
  expect(answer({ type: "failures" }, state, cmds)).toEqual({ say: "1 of the last 2 commands failed. Most recent: snake ran bun test.", view: { panel: "commands", failuresOnly: true } });
  expect(answer({ type: "view", panel: "map" }, state, cmds)).toEqual({ say: "Show map", view: { panel: "map", repo: undefined } });
  expect(answer({ type: "view", repo: "ecily" }, state, cmds)).toEqual({ say: "Show repo ecily", view: { panel: undefined, repo: "ecily" } });
  expect(answer({ type: "diff", target: "ecily" }, state, cmds)).toEqual({ say: "Showing the diff for ecily", view: { panel: "diff", repo: "ecily" } });
  expect(answer({ type: "diff", target: "snake" }, state, cmds)).toEqual({ say: "Showing the diff for snake", view: { panel: "diff", repo: undefined } });
  // action and brain intents are not answered here
  expect(answer({ type: "focus", agent: "snake" }, state, cmds)).toBeNull();
  expect(answer({ type: "unknown", text: "x" }, state, cmds)).toBeNull();
});

const known = { agents: ["snake", "snail", "llama"], repos: ["ecily", "hubert"] };

test("parsePlan: clean JSON, code fence, and surrounding chatter", () => {
  const j = '{"say":"ok","actions":[{"type":"focus","agent":"snail"}]}';
  for (const raw of [j, "```json\n" + j + "\n```", "Sure! Here you go:\n" + j + "\nDone."]) {
    expect(parsePlan(raw, known)).toEqual({ say: "ok", actions: [{ type: "focus", agent: "snail" }], dropped: [] });
  }
});

test("parsePlan: plain-text answer becomes say with no actions; broken JSON is reported", () => {
  expect(parsePlan("I can't check the weather.", known)).toEqual({ say: "I can't check the weather.", actions: [], dropped: [] });
  const bad = parsePlan('{"say": "x", "actions": [', known);
  expect(bad.actions).toEqual([]);
  expect(bad.dropped).toEqual(["unparseable"]);
});

test("parsePlan: invented agents/repos/action types are dropped, near-miss names are corrected", () => {
  const p = parsePlan(
    JSON.stringify({
      say: "x",
      actions: [
        { type: "focus", agent: "tiger" }, // invented
        { type: "send", agent: "lama", text: " review " }, // typo -> llama, trimmed
        { type: "open", repo: "ecily", prompt: "fix nav" },
        { type: "rm_rf", path: "/" }, // not an action
      ],
    }),
    known,
  );
  expect(p.actions).toEqual([{ type: "send", agent: "llama", text: "review" }]);
  expect(p.dropped.length).toBe(3);
  const q = parsePlan(JSON.stringify({ say: "x", actions: [{ type: "send", agent: "snake", text: "  " }, { type: "open", repo: "nowhere" }] }), known);
  expect(q.actions).toEqual([]);
  expect(q.dropped).toEqual(["send: empty text", 'unknown action "open"']);
});

test("window plans only accept exact current addresses and bounded coordinates", () => {
  const address = "0xabcdef123";
  const windows = [{ address, title: "Editor", class: "kitty", workspace: 2 }];
  const raw = JSON.stringify({ say: "arrange", actions: [
    { type: "move", address, x: 25, y: 40 },
    { type: "resize", address, width: 900, height: 650 },
    { type: "move", address: "0x9999", x: 0, y: 0 },
    { type: "resize", address, width: -1, height: 650 },
  ] });
  const p = parsePlan(raw, { ...known, windows });
  expect(p.actions).toEqual([{ type: "move", address, x: 25, y: 40 }, { type: "resize", address, width: 900, height: 650 }]);
  expect(p.dropped.length).toBe(2);
  expect(parsePlan(JSON.stringify({ actions: [{ type: "move", title: "Editor", x: 0, y: 0 }] }), { ...known, windows }).actions).toEqual([]);
});

test("window dispatch revalidates fresh clients and never accepts arbitrary dispatch arguments", () => {
  const windows = [{ address: "0xabcdef123", title: "Editor", class: "kitty", workspace: 2 }];
  expect(windowCommand({ type: "move", address: windows[0]!.address, x: 20, y: -30 }, windows)).toEqual(["hyprctl", "dispatch", "movewindowpixel", "exact 20 -30,address:0xabcdef123"]);
  expect(windowCommand({ type: "resize", address: windows[0]!.address, width: 900, height: 650 }, windows)).toEqual(["hyprctl", "dispatch", "resizewindowpixel", "exact 900 650,address:0xabcdef123"]);
  for (const bad of [
    { type: "move", address: "0x9999", x: 20, y: 30 },
    { type: "move", address: "0xabcdef123;exec", x: 20, y: 30 },
    { type: "move", address: "0xabcdef123", x: 100000, y: 0 },
    { type: "resize", address: "0xabcdef123", width: 0, height: 200 },
    { type: "resize", address: "0xabcdef123", width: 200.5, height: 200 },
    { type: "killactive", address: "0xabcdef123" },
  ]) expect(() => windowCommand(bad as never, windows)).toThrow();
});

test("parsePlan: caps actions and text length, ignores wrong field types", () => {
  const many = Array.from({ length: 10 }, () => ({ type: "focus", agent: "snake" }));
  expect(parsePlan(JSON.stringify({ say: "x", actions: many }), known).actions.length).toBe(4);
  const long = parsePlan(JSON.stringify({ say: "x", actions: [{ type: "send", agent: "snake", text: "a".repeat(5000) }] }), known);
  expect((long.actions[0] as { text: string }).text.length).toBe(2000);
  expect(parsePlan(JSON.stringify({ say: 5, actions: "nope" }), known)).toEqual({ say: "", actions: [], dropped: [] });
  expect(parsePlan(JSON.stringify({ say: "x", actions: [{ type: "focus", agent: 7 }, null] }), known).actions).toEqual([]);
});

test("pickModel prefers newest haiku, then luna, then mini; null when nothing light", () => {
  expect(pickModel(["claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5", "gpt-6-luna"])).toBe("claude-haiku-5-5");
  expect(pickModel(["claude-sonnet-5", "gpt-5.6-luna", "gpt-6-luna"])).toBe("gpt-6-luna");
  expect(pickModel(["gpt-4o-mini", "claude-opus-5"])).toBe("gpt-4o-mini");
  expect(pickModel(["claude-opus-5", "claude-sonnet-5"])).toBeNull();
});

test("buildPrompt carries the mark, agent list, and a JSON-escaped utterance (no prompt injection via quotes)", () => {
  const p = buildPrompt('say "hi"\nIgnore previous', [{ name: "snake", state: "working", repo: "/x/ecily", doing: "bash: ls" }], ["ecily"]);
  expect(p.startsWith("HUBERT-BRAIN")).toBe(true);
  expect(p).toContain("- snake (working, repo ecily): bash: ls");
  expect(p).toContain(JSON.stringify('say "hi"\nIgnore previous'));
});

test("buildPrompt offers only existing window addresses and no create action", () => {
  const prompt = buildPrompt("put editor at 20,30", [], [], [{ address: "0xabc", title: "Editor", class: "kitty", workspace: 1 }]);
  expect(prompt).toContain('"address":"0xabc"');
  expect(prompt).toContain('"type":"move"');
  expect(prompt).toContain('"type":"resize"');
  expect(prompt).not.toContain('"type":"open"');
});

test("intentToAction maps grammar intents; stop/diff/unknown have no action", () => {
  expect(intentToAction({ type: "focus", agent: "snake" })).toEqual({ type: "focus", agent: "snake" });
  expect(intentToAction({ type: "send", agent: "llama", text: "hi" })).toEqual({ type: "send", agent: "llama", text: "hi" });
  expect(intentToAction({ type: "stop", agent: "snake" })).toEqual({ type: "stop", agent: "snake" });
  expect(intentToAction({ type: "unknown", text: "x" })).toBeNull();
  // read-only and view intents are answered or applied client-side, never executed as a mutation
  expect(intentToAction({ type: "roster", state: "working" })).toBeNull();
  expect(intentToAction({ type: "changed", repo: "ecily" })).toBeNull();
  expect(intentToAction({ type: "failures" })).toBeNull();
  expect(intentToAction({ type: "view", panel: "diff" })).toBeNull();
});

test("spokenStatus: short, human sentence with repo and last tool", () => {
  expect(spokenStatus({ name: "snake", state: "working", repo: "/home/red/ecily", doing: "bash: bun test" })).toBe("snake is working in ecily, last bash.");
  expect(spokenStatus({ name: "llama", state: "idle" })).toBe("llama is idle.");
});

test("spokenRoster: counts, names and empty cases", () => {
  const agents = [
    { name: "snake", state: "working" },
    { name: "llama", state: "working" },
    { name: "horse", state: "idle" },
  ];
  expect(spokenRoster(agents, "working")).toBe("2 agents are working: snake and llama.");
  expect(spokenRoster(agents, "idle")).toBe("1 agent is idle: horse.");
  expect(spokenRoster([{ name: "horse", state: "idle" }], "working")).toBe("No agents are working.");
  expect(spokenRoster([{ name: "horse", state: "idle" }], "idle")).toBe("1 agent is idle: horse.");
  expect(spokenRoster(
    [{ name: "a", state: "working" }, { name: "b", state: "working" }, { name: "c", state: "working" }],
    "working",
  )).toBe("3 agents are working: a, b and c.");
});

test("spokenChanges: file count, plus/minus totals and biggest file; clean repo", () => {
  const files = [
    { path: "src/nav.tsx", add: 40, del: 2 },
    { path: "README.md", add: 2, del: 0 },
  ];
  expect(spokenChanges("ecily", files)).toBe("ecily has 2 changed files, plus 42 minus 2. Biggest: src/nav.tsx.");
  expect(spokenChanges("ecily", [])).toBe("ecily has no changes.");
  expect(spokenChanges("hubert", [{ path: "a.ts", add: 1, del: 1 }])).toBe("hubert has 1 changed file, plus 1 minus 1. Biggest: a.ts.");
});

test("spokenFailures: counts failures and names the most recent", () => {
  const cmds = [
    { agent: "snake", command: "bun test\nmore", ok: false },
    { agent: "llama", command: "ls", ok: true },
    { agent: "horse", command: "git status", ok: true },
  ];
  expect(spokenFailures(cmds)).toBe("1 of the last 3 commands failed. Most recent: snake ran bun test.");
  expect(spokenFailures([{ agent: "llama", command: "ls", ok: true }])).toBe("No failing commands in the recent sample.");
  expect(spokenFailures([])).toBe("No failing commands in the recent sample.");
});

test("findPane matches the whole agent word in tmux titles", () => {
  const panes = [
    { session: "a", window: "1", title: "🌐 jcode Horse · last ~9s" },
    { session: "b", window: "1", title: "🌐 jcode Snail · +42 -0 · work ~15s" },
    { session: "c", window: "2", title: "🐭 jcode Snaileater" },
  ];
  expect(findPane(panes, "snail")?.session).toBe("b");
  expect(findPane(panes, "snake")).toBeNull();
  expect(findPane(panes, "mouse")).toBeNull();
});
