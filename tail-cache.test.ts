import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cachedTailLines, clearTailCache, tailCacheStats } from "./tail-cache";

test("cachedTailLines caches by mtime+size and re-reads after a change", () => {
  const dir = mkdtempSync(join(tmpdir(), "hubert-cache-"));
  try {
    clearTailCache();
    const file = join(dir, "journal.jsonl");
    writeFileSync(file, JSON.stringify({ a: 1 }) + "\n");
    const first = tailCacheStats();
    expect(cachedTailLines(file, 64 * 1024)).toEqual([{ a: 1 }]);
    expect(tailCacheStats()).toMatchObject({ hits: first.hits, misses: first.misses + 1 });
    // unchanged file: served from cache
    expect(cachedTailLines(file, 64 * 1024)).toEqual([{ a: 1 }]);
    expect(tailCacheStats()).toMatchObject({ hits: first.hits + 1, misses: first.misses + 1 });
    // appended file: size changes, so the cache must miss and return new lines
    appendFileSync(file, JSON.stringify({ b: 2 }) + "\n");
    expect(cachedTailLines(file, 64 * 1024)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(tailCacheStats()).toMatchObject({ hits: first.hits + 1, misses: first.misses + 2 });
  } finally { clearTailCache(); rmSync(dir, { recursive: true, force: true }); }
});

test("cachedTailLines reads only the tail and skips a partial first line", () => {
  const dir = mkdtempSync(join(tmpdir(), "hubert-cache-"));
  try {
    clearTailCache();
    const file = join(dir, "big.jsonl");
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i }));
    writeFileSync(file, lines.join("\n") + "\n");
    // Read only the last ~100 bytes, which starts mid-line.
    const got = cachedTailLines(file, 100);
    expect(got.length).toBeGreaterThan(0);
    expect(got.at(-1)).toEqual({ i: 49 });
    expect(got.every((x) => typeof x.i === "number")).toBe(true);
  } finally { clearTailCache(); rmSync(dir, { recursive: true, force: true }); }
});

test("cachedTailLines returns [] for a missing file", () => {
  clearTailCache();
  expect(cachedTailLines(join(tmpdir(), "hubert-does-not-exist-xyz.jsonl"), 1024)).toEqual([]);
});
