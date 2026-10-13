import { expect, test } from "bun:test";
import { describe as say, fuzzy, parseIntent, phonetic } from "./intent";

const known = { agents: ["snake", "snail", "llama", "horse"], repos: ["ecily", "hubert", "leadlarp"] };

test("fuzzy: exact, one typo, ambiguity, miss", () => {
  expect(fuzzy("snake", known.agents)).toBe("snake");
  expect(fuzzy("lama", known.agents)).toBe("llama"); // one dropped letter
  expect(fuzzy("snaik", ["snake", "snail"])).toBe("snail"); // 1 edit from snail, 2 from snake
  expect(fuzzy("snaie", ["snake", "snail"])).toBeNull(); // 1 edit from both: refuse to guess
  expect(fuzzy("banana", known.agents)).toBeNull();
});

test("fuzzy: real whisper homophones and plurals resolve when unambiguous", () => {
  expect(fuzzy("lamma", known.agents)).toBe("llama"); // doubled letter, beyond the edit limit
  expect(fuzzy("lama llama", known.agents)).toBeNull(); // two words is not a name
  expect(fuzzy("hoarse", known.agents)).toBe("horse"); // homophone
  expect(fuzzy("snakes", known.agents)).toBe("snake"); // plural
  expect(fuzzy("snails", known.agents)).toBe("snail");
  expect(fuzzy("snakes", ["snake", "snail"])).toBe("snake"); // plural only lands on one
  expect(fuzzy("horse snail", known.agents)).toBeNull();
});

test("phonetic collapses vowels and digraphs so sound-alikes share a key", () => {
  expect(phonetic("horse")).toBe(phonetic("hoarse"));
  expect(phonetic("llama")).toBe(phonetic("lamma")); // doubled letters collapse
  expect(phonetic("snake")).not.toBe(phonetic("snail")); // still distinguishable
});

test("focus", () => {
  expect(parseIntent("Switch to snake.", known)).toEqual({ type: "focus", agent: "snake" });
  expect(parseIntent("hey, go to llama", known)).toEqual({ type: "focus", agent: "llama" });
  expect(parseIntent("focus on the horse", known)).toEqual({ type: "focus", agent: "horse" });
});

test("tolerates STT artifacts seen in real transcripts: repeats, filler, trailing please/agent", () => {
  const want = { type: "focus", agent: "snake" } as const;
  expect(parseIntent("Switch to snake. Switch to snake.", known)).toEqual(want); // looped mic
  expect(parseIntent("Switch to snake, switch to snake.", known)).toEqual(want); // real whisper output
  expect(parseIntent("switch to snake please", known)).toEqual(want);
  expect(parseIntent("Switch to the snake", known)).toEqual(want);
  expect(parseIntent("go to snake agent", known)).toEqual(want);
  expect(parseIntent("Hubert, switch to snake", known)).toEqual(want);
  // two different commands are not collapsed
  expect(parseIntent("Switch to snake. Stop llama.", known).type).toBe("unknown");
});

test("send", () => {
  expect(parseIntent("Tell llama to review the nav changes", known)).toEqual({ type: "send", agent: "llama", text: "review the nav changes" });
  expect(parseIntent("Ask snake that the build is red", known)).toEqual({ type: "send", agent: "snake", text: "the build is red" });
});

test("stop and status", () => {
  expect(parseIntent("stop horse", known)).toEqual({ type: "stop", agent: "horse" });
  expect(parseIntent("interrupt the llama", known)).toEqual({ type: "stop", agent: "llama" });
  expect(parseIntent("what is llama doing?", known)).toEqual({ type: "status", agent: "llama" });
  expect(parseIntent("what's snake up to", known)).toEqual({ type: "status", agent: "snake" });
  expect(parseIntent("status of horse", known)).toEqual({ type: "status", agent: "horse" });
  expect(parseIntent("how's snail going", known)).toEqual({ type: "status", agent: "snail" });
});

test("roster: who is working or idle", () => {
  const w = { type: "roster", state: "working" } as const;
  for (const t of [
    "which agents are working",
    "what agents are working",
    "who is working",
    "who's working",
    "who is working right now",
    "show me the working agents",
    "show me which agents are working",
    "are any agents working",
  ]) expect({ [t]: parseIntent(t, known).type }).toEqual({ [t]: "roster" });
  expect(parseIntent("which agents are working", known)).toEqual(w);
  expect(parseIntent("who's working", known)).toEqual(w);
  expect(parseIntent("which agents are idle", known)).toEqual({ type: "roster", state: "idle" });
  expect(parseIntent("idle agents", known)).toEqual({ type: "roster", state: "idle" });
  // "working on" is a status question, not a roster
  expect(parseIntent("what is snake working on", known)).toEqual({ type: "status", agent: "snake" });
});

test("changed: what changed in a repo", () => {
  expect(parseIntent("what changed in ecily", known)).toEqual({ type: "changed", repo: "ecily" });
  expect(parseIntent("what's changed in ecily", known)).toEqual({ type: "changed", repo: "ecily" });
  expect(parseIntent("what has changed in the hubert repo", known)).toEqual({ type: "changed", repo: "hubert" });
  expect(parseIntent("whats changed in leadlarp", known)).toEqual({ type: "changed", repo: "leadlarp" });
  expect(parseIntent("what changed", known)).toEqual({ type: "changed" });
  // unknown repo is not silently widened to "all repos"
  expect(parseIntent("what changed in banana", known).type).toBe("unknown");
});

test("failures: show failing commands", () => {
  for (const t of ["show failing commands", "show me the failures", "what failed", "what commands failed", "any failures?", "show failed tests", "what commands are failing"])
    expect({ [t]: parseIntent(t, known).type }).toEqual({ [t]: "failures" });
});

test("view: switch panel and select repo, client-side only", () => {
  expect(parseIntent("show the change map", known)).toEqual({ type: "view", panel: "map" });
  expect(parseIntent("switch to the agents panel", known)).toEqual({ type: "view", panel: "agents" });
  expect(parseIntent("open commands", known)).toEqual({ type: "view", panel: "commands" });
  expect(parseIntent("switch to the diff panel", known)).toEqual({ type: "view", panel: "diff" });
  expect(parseIntent("select repo ecily", known)).toEqual({ type: "view", repo: "ecily" });
  expect(parseIntent("switch to the leadlarp repo", known)).toEqual({ type: "view", repo: "leadlarp" });
  // an unknown repo is refused, not defaulted
  expect(parseIntent("select repo banana", known).type).toBe("unknown");
});

test("diff", () => {
  expect(parseIntent("show diff", known)).toEqual({ type: "view", panel: "diff" }); // bare panel switch, no target
  expect(parseIntent("show the diff for ecily", known)).toEqual({ type: "diff", target: "ecily" });
  expect(parseIntent("diff for snake", known)).toEqual({ type: "diff", target: "snake" });
});

test("voice never parses an instruction to create a window or agent", () => {
  expect(parseIntent("open a new agent in ecily", known).type).toBe("unknown");
  expect(parseIntent("new agent", known).type).toBe("unknown");
  expect(parseIntent("open a new window", known).type).toBe("unknown");
});

test("unknown agent name is not guessed, so it falls through to unknown", () => {
  expect(parseIntent("switch to banana", known).type).toBe("unknown");
  expect(parseIntent("what's the weather", known).type).toBe("unknown");
  expect(parseIntent("stop the tiger", known).type).toBe("unknown");
});

test("describe", () => {
  expect(say({ type: "send", agent: "llama", text: "hi" })).toBe("Tell llama: hi");
  expect(say({ type: "roster", state: "working" })).toBe("Show working agents");
  expect(say({ type: "changed", repo: "ecily" })).toBe("What changed in ecily");
  expect(say({ type: "failures" })).toBe("Show failing commands");
  expect(say({ type: "view", repo: "hubert" })).toBe("Show repo hubert");
});
