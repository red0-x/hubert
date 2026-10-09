import { expect, test } from "bun:test";
import { buildPrompt, intentToAction, parsePlan, pickModel } from "./brain";
import { findPane, windowCommand } from "./actions";

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
