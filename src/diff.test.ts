import { expect, test } from "bun:test";
import { groupHunks, inlineHighlights, parseDiff, splitRows, wordDiff } from "./diff";

test("parses hunks with line numbers and counts", () => {
  const d = parseDiff("diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@ fn f() {\n a\n-b\n+c\n+d\n");
  expect([d.add, d.del]).toEqual([2, 1]);
  expect(d.lines.map(l => [l.kind, l.old, l.new])).toEqual([["hunk", undefined, undefined], ["ctx", 3, 3], ["del", 4, undefined], ["add", undefined, 4], ["add", undefined, 5]]);
  expect(d.lines[0]!.text).toBe("fn f() {");
  expect(d.binary).toBe(false);
});
test("raw untracked content is all added", () => {
  const d = parseDiff("a\nb\n");
  expect([d.add, d.lines.length, d.lines[1]!.new]).toEqual([2, 2, 2]);
});
test("empty", () => expect(parseDiff("").lines).toEqual([]));

test("binary content is flagged and yields no rows", () => {
  const git = parseDiff("diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n");
  expect([git.binary, git.lines.length]).toEqual([true, 0]);
  expect(parseDiff("a\u0000b\n").binary).toBe(true);
});

test("rename from/to is captured and not shown as a meta row", () => {
  const d = parseDiff("diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\nindex 1..2 100644\n--- a/old.ts\n+++ b/new.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n");
  expect(d.renames).toEqual([{ from: "old.ts", to: "new.ts" }]);
  expect(d.lines.some(l => l.kind === "meta")).toBe(false);
  expect([d.add, d.del]).toEqual([1, 1]);
});

test("groupHunks splits into preamble and collapsible hunks with per-hunk counts", () => {
  const d = parseDiff("diff --git a/x b/x\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+a\n@@ -10,2 +11,3 @@ fn\n ctx\n-b\n+c\n+d\n");
  const { preamble, hunks } = groupHunks(d.lines);
  expect(preamble.map(l => l.text)).toEqual(["new file mode 100644"]);
  expect(hunks.length).toBe(2);
  expect([hunks[0]!.add, hunks[0]!.del]).toEqual([1, 0]);
  expect([hunks[1]!.add, hunks[1]!.del]).toEqual([2, 1]);
  expect(hunks[1]!.header).toBe("fn");
});

test("wordDiff marks only the changed tokens", () => {
  const { left, right } = wordDiff("const a = 1;", "const a = 2;");
  expect(left.find(s => s.changed)?.text.trim()).toBe("1;");
  expect(right.find(s => s.changed)?.text.trim()).toBe("2;");
  expect(left.some(s => !s.changed && s.text.includes("const a"))).toBe(true);
  const none = wordDiff("same line", "same line");
  expect(none.left.every(s => !s.changed) && none.right.every(s => !s.changed)).toBe(true);
});

test("splitRows pairs del/add runs and keeps context on both sides", () => {
  const d = parseDiff("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n same\n");
  const rows = splitRows(d.lines.filter(l => l.kind !== "hunk"));
  expect(rows.map(r => r.kind)).toEqual(["ctx", "change", "ctx"]);
  expect(rows[1]!.old!.text).toBe("old");
  expect(rows[1]!.new!.text).toBe("new");
  expect(rows[1]!.pair!.right.some(s => s.changed)).toBe(true);
});

test("splitRows reports more dels than adds and stray adds without crashing", () => {
  const rows = splitRows(parseDiff("diff --git a/x b/x\n@@ -1,2 +1,1 @@\n-a\n-b\n+c\n").lines.filter(l => l.kind !== "hunk"));
  expect(rows.length).toBe(2);
  expect(rows[1]!.old!.text).toBe("b");
  expect(rows[1]!.new).toBeUndefined();
  expect(rows[1]!.pair).toBeUndefined();
});

test("inlineHighlights keys changed lines to their segments", () => {
  const d = parseDiff("diff --git a/x b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n");
  const marks = inlineHighlights(d.lines.filter(l => l.kind !== "hunk"));
  const del = d.lines.find(l => l.kind === "del")!;
  expect(marks.get(del)?.some(s => s.changed)).toBe(true);
});
