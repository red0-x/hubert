import { expect, test } from "bun:test";
import { describe as say, fuzzy, parseIntent } from "./intent";

const known = { agents: ["snake", "snail", "llama", "horse"], repos: ["ecily", "hubert", "leadlarp"] };

test("fuzzy: exact, one typo, ambiguity, miss", () => {
  expect(fuzzy("snake", known.agents)).toBe("snake");
  expect(fuzzy("lama", known.agents)).toBe("llama"); // one dropped letter
  expect(fuzzy("snaik", ["snake", "snail"])).toBe("snail"); // 1 edit from snail, 2 from snake
  expect(fuzzy("snaie", ["snake", "snail"])).toBeNull(); // 1 edit from both: refuse to guess
  expect(fuzzy("banana", known.agents)).toBeNull();
});

test("focus", () => {
  expect(parseIntent("Switch to snake.", known)).toEqual({ type: "focus", agent: "snake" });
  expect(parseIntent("hey, go to llama", known)).toEqual({ type: "focus", agent: "llama" });
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
});

test("stop and status", () => {
  expect(parseIntent("stop horse", known)).toEqual({ type: "stop", agent: "horse" });
  expect(parseIntent("what is llama doing?", known)).toEqual({ type: "status", agent: "llama" });
  expect(parseIntent("what's snake up to", known)).toEqual({ type: "status", agent: "snake" });
});

test("diff", () => {
  expect(parseIntent("show diff", known)).toEqual({ type: "diff", target: undefined });
  expect(parseIntent("show the diff for ecily", known)).toEqual({ type: "diff", target: "ecily" });
});

test("voice never parses an instruction to create a window or agent", () => {
  expect(parseIntent("open a new agent in ecily", known).type).toBe("unknown");
  expect(parseIntent("new agent", known).type).toBe("unknown");
});

test("unknown agent name is not guessed, so it falls through to unknown", () => {
  expect(parseIntent("switch to banana", known).type).toBe("unknown");
  expect(parseIntent("what's the weather", known).type).toBe("unknown");
});

test("describe", () => {
  expect(say({ type: "send", agent: "llama", text: "hi" })).toBe("Tell llama: hi");
});
