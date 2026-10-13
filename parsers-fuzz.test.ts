import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { jsonLines, cachedTailLines } from "./tail-cache";
import { lastTool, codexDoing, piDoing, parseChanges, resolveSlug } from "./state";
import { recentCommands, editEvents, codexCommands, codexEdits } from "./live";

// Every parser here reads a transcript written by another process we do not control. A poll runs
// these on a timer, so any shape it cannot understand must be skipped, never thrown. These tests
// feed each parser malformed input (truncated JSON, primitives, huge lines, empty files, binary
// garbage, missing fields) and assert it neither throws nor invents records.

const BINARY = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x7f, 0x80, 0xc3, 0x28, 0xed, 0xa0, 0x80]).toString("utf8");

/** Lines that parse to something other than a plain session record, or do not parse at all. */
const JUNK_LINES = [
  "",
  "   ",
  "{",
  '{"unterminated":',
  '{"a":',
  "[1,2,3]",
  "null",
  "true",
  "false",
  "42",
  "3.14",
  '"just a string"',
  "\u0000\u0001\u0002",
  "not json at all",
  "{\"type\":\"message\",\"message\":null}",
  BINARY,
];

const junkText = JUNK_LINES.join("\n");

test("jsonLines never throws and only returns non-null objects", () => {
  expect(() => jsonLines(junkText)).not.toThrow();
  // null, numbers, strings, booleans and arrays all parse but are not records.
  expect(jsonLines(junkText)).toEqual([{ type: "message", message: null }]);
  expect(jsonLines("")).toEqual([]);
  expect(jsonLines({} as unknown as string)).toEqual([]); // non-string input (defensive)
  expect(jsonLines(BINARY)).toEqual([]);
});

test("jsonLines skips a single line larger than the cap instead of parsing megabytes", () => {
  const huge = JSON.stringify({ type: "message", message: { content: "x".repeat(9 * 1024 * 1024) } });
  expect(jsonLines(`{"ok":1}\n${huge}\n{"also":2}`)).toEqual([{ ok: 1 }, { also: 2 }]);
});

test("cachedTailLines survives empty, binary and oversized files", () => {
  const dir = mkdtempSync(join(tmpdir(), "hubert-fuzz-tail-"));
  try {
    const empty = join(dir, "empty.jsonl");
    const bin = join(dir, "bin.jsonl");
    writeFileSync(empty, "");
    writeFileSync(bin, Buffer.from([0, 1, 2, 255, 254, 253]));
    expect(cachedTailLines(empty, 4096)).toEqual([]);
    expect(() => cachedTailLines(bin, 4096)).not.toThrow();
    expect(() => cachedTailLines(join(dir, "missing"), 4096)).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("message-block parsers tolerate null, primitive and non-iterable inputs", () => {
  const hostile = [null, 42, "text", { message: null }, { message: 7 }, { message: { content: 5 } },
    { message: { content: "not an array" } }];
  for (const value of hostile) {
    expect(() => piDoing([value as any])).not.toThrow();
    expect(() => codexDoing([value as any])).not.toThrow();
    expect(piDoing([value as any])).toBeUndefined();
    expect(codexDoing([value as any])).toBeUndefined();
  }
  expect(() => lastTool([null as any, 5 as any, [{ type: "tool_use", name: "bash", input: null }]])).not.toThrow();
  expect(lastTool([[{ type: "tool_use", name: "bash" }]])).toBe("bash");
  expect(() => lastTool([null as any])).not.toThrow();
  // A toolCall block survives null siblings, and one with no fields must not throw.
  expect(piDoing([{ message: { content: [null, 3, "x", { type: "toolCall", name: "bash", arguments: { command: "ls" } }] } }])).toBe("bash: ls");
  expect(() => piDoing([{ message: { content: [null, 3, "x", { type: "toolCall" }] } }])).not.toThrow();
});

test("parseChanges and resolveSlug tolerate malformed git and path input", () => {
  expect(() => parseChanges("garbage\n\n\x00\x01", "not\ttabbed\n3\t1")).not.toThrow();
  expect(parseChanges("", "")).toEqual([]);
  expect(parseChanges(" M a.ts\n", "1\t2\ta.ts\nnot a numstat line")).toEqual([{ path: "a.ts", status: "M", add: 1, del: 2 }]);
  expect(() => resolveSlug("")).not.toThrow();
  expect(resolveSlug("", "/nonexistent-base-xyz")).toBeNull();
});

test("recentCommands and editEvents skip malformed lines without dropping a valid sibling", () => {
  const base = mkdtempSync(join(tmpdir(), "hubert-fuzz-live-"));
  try {
    const j = join(base, "jcode"), c = join(base, "claude"), codex = join(base, "no-codex");
    mkdirSync(j); mkdirSync(join(c, "proj"), { recursive: true });
    const validToolUse = JSON.stringify({ append_messages: [{ role: "assistant", content: [{ type: "tool_use", id: "ok", name: "bash", input: { command: "echo hi" } }] }] });
    const validResult = JSON.stringify({ append_messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "ok", content: "hi" }] }] });
    writeFileSync(join(j, "s.json"), JSON.stringify({ short_name: "t", working_dir: base }));
    writeFileSync(join(j, "s.journal.jsonl"), [junkText, validToolUse, validResult, junkText].join("\n"));
    const claudeLines = [junkText, JSON.stringify({ type: "assistant", cwd: base, timestamp: "2026-10-08T05:00:00Z", message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "pwd" } }] } }), JSON.stringify({ type: "user", timestamp: "2026-10-08T05:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] } }), junkText];
    writeFileSync(join(c, "proj", "t.jsonl"), claudeLines.join("\n"));
    let commands: ReturnType<typeof recentCommands> = [];
    expect(() => { commands = recentCommands(j, c, codex); }).not.toThrow();
    expect(commands.map((x) => x.command).sort()).toEqual(["echo hi", "pwd"]);
    let events: ReturnType<typeof editEvents> = [];
    expect(() => { events = editEvents([{ root: base }], j, c, codex); }).not.toThrow();
    expect(Array.isArray(events)).toBe(true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("codex parsers skip junk rows and survive a malformed changes field", () => {
  const dir = mkdtempSync(join(tmpdir(), "hubert-fuzz-cx-"));
  try {
    const day = join(dir, "2026", "10", "09");
    mkdirSync(day, { recursive: true });
    const rows = [
      ...JUNK_LINES,
      JSON.stringify({ type: "turn_context", payload: { cwd: "/repo" } }),
      JSON.stringify({ timestamp: "2026-10-09T10:00:00Z", type: "event_msg", payload: { type: "patch_apply_end", success: true, changes: "/repo/not-an-object" } }),
      JSON.stringify({ timestamp: "2026-10-09T10:00:01Z", type: "event_msg", payload: { type: "patch_apply_end", success: true, changes: { "/repo/src/ok.ts": { type: "update" } } } }),
      JSON.stringify({ timestamp: "2026-10-09T10:00:02Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "z", name: "exec", input: 12345 } }),
      JSON.stringify({ timestamp: "2026-10-09T10:00:03Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "z", output: null } }),
    ];
    writeFileSync(join(day, "rollout-x-0123456789abcdef0123456789abcdef0123.jsonl"), rows.join("\n") + "\n" + BINARY);
    let edits: ReturnType<typeof codexEdits> = [];
    let cmds: ReturnType<typeof codexCommands> = [];
    expect(() => { edits = codexEdits([{ root: "/repo" }], dir); }).not.toThrow();
    expect(() => { cmds = codexCommands(dir); }).not.toThrow();
    expect(edits.map((e) => e.path)).toEqual(["src/ok.ts"]);
    expect(cmds).toEqual([]); // call_id "z" pair had no parsable command: must not fabricate one
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
