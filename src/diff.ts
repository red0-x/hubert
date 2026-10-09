export type DiffLine = { kind: "hunk" | "add" | "del" | "ctx" | "meta"; text: string; old?: number; new?: number };

/** Unified diff -> display rows with line numbers. Untracked files arrive as raw content, shown as all-added. */
export function parseDiff(raw: string): { lines: DiffLine[]; add: number; del: number } {
  const out: DiffLine[] = [];
  let add = 0, del = 0, o = 0, n = 0, inHunk = false;
  const isDiff = raw.startsWith("diff --git");
  const src = raw.replace(/\n$/, "").split("\n");
  if (!raw) return { lines: [], add, del };
  if (!isDiff) return { lines: src.map((text, i) => ({ kind: "add", text, new: i + 1 })), add: src.length, del: 0 };
  for (const l of src) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(l);
    if (h) { o = +h[1]!; n = +h[2]!; inHunk = true; out.push({ kind: "hunk", text: h[3]!.trim() }); continue; }
    if (l.startsWith("diff --git")) { inHunk = false; continue; }
    if (!inHunk) { if (/^(Binary files|rename |new file|deleted file)/.test(l)) out.push({ kind: "meta", text: l }); continue; }
    if (l.startsWith("+")) { add++; out.push({ kind: "add", text: l.slice(1), new: n++ }); }
    else if (l.startsWith("-")) { del++; out.push({ kind: "del", text: l.slice(1), old: o++ }); }
    else if (l.startsWith("\\")) out.push({ kind: "meta", text: l });
    else out.push({ kind: "ctx", text: l.slice(1), old: o++, new: n++ });
  }
  return { lines: out, add, del };
}
