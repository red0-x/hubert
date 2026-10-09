import { expect, test } from "bun:test";
import { parseDiff } from "./diff";

test("parses hunks with line numbers and counts", () => {
  const d = parseDiff("diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@ fn f() {\n a\n-b\n+c\n+d\n");
  expect([d.add, d.del]).toEqual([2, 1]);
  expect(d.lines.map(l => [l.kind, l.old, l.new])).toEqual([["hunk", undefined, undefined], ["ctx", 3, 3], ["del", 4, undefined], ["add", undefined, 4], ["add", undefined, 5]]);
  expect(d.lines[0]!.text).toBe("fn f() {");
});
test("raw untracked content is all added", () => {
  const d = parseDiff("a\nb\n");
  expect([d.add, d.lines.length, d.lines[1]!.new]).toEqual([2, 2, 2]);
});
test("empty", () => expect(parseDiff("").lines).toEqual([]));
