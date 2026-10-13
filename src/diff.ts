export type DiffLine = { kind: "hunk" | "add" | "del" | "ctx" | "meta"; text: string; old?: number; new?: number };

export type DiffResult = { lines: DiffLine[]; add: number; del: number; binary: boolean; renames: { from: string; to: string }[] };

const BINARY_RE = /^Binary files .* differ$|^GIT binary patch$/m;

/**
 * Unified diff -> display rows with line numbers. Untracked files arrive as raw content, shown as all-added.
 * Binary content (null bytes or a git binary stanza) returns no rows and `binary: true` so the UI can say so.
 */
export function parseDiff(raw: string): DiffResult {
  const out: DiffLine[] = [];
  let add = 0, del = 0, o = 0, n = 0, inHunk = false;
  const isDiff = raw.startsWith("diff --git");
  const binary = BINARY_RE.test(raw) || raw.includes("\0");
  const renames: { from: string; to: string }[] = [];
  let renameFrom: string | undefined;
  if (!raw || binary) return { lines: [], add, del, binary, renames };
  const src = raw.replace(/\n$/, "").split("\n");
  if (!isDiff) return { lines: src.map((text, i) => ({ kind: "add", text, new: i + 1 })), add: src.length, del, binary, renames };
  for (const l of src) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(l);
    if (h) { o = +h[1]!; n = +h[2]!; inHunk = true; out.push({ kind: "hunk", text: h[3]!.trim() }); continue; }
    if (l.startsWith("diff --git")) { inHunk = false; renameFrom = undefined; continue; }
    if (/^rename from (.+)$/.test(l)) { renameFrom = l.slice("rename from ".length); continue; }
    if (/^rename to (.+)$/.test(l)) { if (renameFrom != null) renames.push({ from: renameFrom, to: l.slice("rename to ".length) }); continue; }
    if (!inHunk) { if (/^(Binary files|new file|deleted file)/.test(l)) out.push({ kind: "meta", text: l }); continue; }
    if (l.startsWith("+")) { add++; out.push({ kind: "add", text: l.slice(1), new: n++ }); }
    else if (l.startsWith("-")) { del++; out.push({ kind: "del", text: l.slice(1), old: o++ }); }
    else if (l.startsWith("\\")) out.push({ kind: "meta", text: l });
    else out.push({ kind: "ctx", text: l.slice(1), old: o++, new: n++ });
  }
  return { lines: out, add, del, binary, renames };
}

export type DiffHunk = { header: string; rows: DiffLine[]; add: number; del: number };

/** Split rows into leading meta ("preamble") and per-hunk groups, so each hunk can be collapsed. */
export function groupHunks(lines: DiffLine[]): { preamble: DiffLine[]; hunks: DiffHunk[] } {
  const preamble: DiffLine[] = [];
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | undefined;
  for (const l of lines) {
    if (l.kind === "hunk") { cur = { header: l.text, rows: [], add: 0, del: 0 }; hunks.push(cur); continue; }
    if (!cur) { preamble.push(l); continue; }
    cur.rows.push(l);
    if (l.kind === "add") cur.add++; else if (l.kind === "del") cur.del++;
  }
  return { preamble, hunks };
}

export type Segment = { text: string; changed: boolean };

function words(s: string): string[] { return s.match(/\s+|\S+/g) ?? []; }

/**
 * Token-level diff of one old/new line pair, for intra-line highlighting.
 * Falls back to prefix/suffix when the token matrix is large (ponytail: keeps a single long line from being O(n^2) slow).
 */
export function wordDiff(oldText: string, newText: string): { left: Segment[]; right: Segment[] } {
  const A = words(oldText), B = words(newText);
  const n = A.length, m = B.length;
  const left: Segment[] = [], right: Segment[] = [];
  const push = (arr: Segment[], text: string, changed: boolean) => {
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += text; else arr.push({ text, changed });
  };
  if (n * m > 160_000) { // too many tokens to LCS cheaply: mark everything past the common prefix/suffix
    let p = 0; while (p < n && p < m && A[p] === B[p]) p++;
    let s = 0; while (s < n - p && s < m - p && A[n - 1 - s] === B[m - 1 - s]) s++;
    for (let i = 0; i < n; i++) push(left, A[i]!, i < p || i >= n - s);
    for (let j = 0; j < m; j++) push(right, B[j]!, j < p || j >= m - s);
    return { left, right };
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push(left, A[i]!, false); push(right, B[j]!, false); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { push(left, A[i]!, true); i++; }
    else { push(right, B[j]!, true); j++; }
  }
  while (i < n) push(left, A[i++]!, true);
  while (j < m) push(right, B[j++]!, true);
  return { left, right };
}

export type SplitRow = { kind: "ctx" | "change" | "meta"; old?: DiffLine; new?: DiffLine; pair?: { left: Segment[]; right: Segment[] } };

/** Pair a run of deletions with the following additions into side-by-side rows, pairing each del/add for word highlighting. */
export function splitRows(rows: DiffLine[]): SplitRow[] {
  const out: SplitRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.kind === "hunk" || r.kind === "meta") { out.push({ kind: "meta", old: r }); continue; }
    if (r.kind === "ctx") { out.push({ kind: "ctx", old: r, new: r }); continue; }
    if (r.kind === "del") {
      const dels: DiffLine[] = [], adds: DiffLine[] = [];
      let k = i;
      while (k < rows.length && rows[k]!.kind === "del") dels.push(rows[k++]!);
      while (k < rows.length && rows[k]!.kind === "add") adds.push(rows[k++]!);
      const count = Math.max(dels.length, adds.length);
      for (let x = 0; x < count; x++) {
        const o = dels[x], nw = adds[x];
        out.push({ kind: "change", old: o, new: nw, pair: o && nw ? wordDiff(o.text, nw.text) : undefined });
      }
      i = k - 1;
    } else out.push({ kind: "change", new: r }); // stray add with no matching del
  }
  return out;
}

/** Map each changed line object to its intra-line segments, for unified view highlighting. Keyed by DiffLine identity. */
export function inlineHighlights(rows: DiffLine[]): Map<DiffLine, Segment[]> {
  const map = new Map<DiffLine, Segment[]>();
  for (const row of splitRows(rows)) {
    if (!row.pair) continue;
    if (row.old?.kind === "del") map.set(row.old, row.pair.left);
    if (row.new?.kind === "add") map.set(row.new, row.pair.right);
  }
  return map;
}
