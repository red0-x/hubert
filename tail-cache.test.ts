import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cachedTailLines, clearMemoCache, clearTailCache, memo, memoAsync, tailCacheStats } from "./tail-cache";

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

test("memo serves a cached value until the ttl expires, and never caches a throw", async () => {
  clearMemoCache();
  let runs = 0;
  const value = () => memo("k", 30, () => ++runs);
  expect(value()).toBe(1);
  expect(value()).toBe(1); // still inside the window
  await Bun.sleep(40);
  expect(value()).toBe(2); // expired, recomputed
  expect(() => memo("boom", 1000, () => { throw new Error("nope"); })).toThrow("nope");
  expect(memo("boom", 1000, () => "recovered")).toBe("recovered");
});

test("memoAsync dedupes concurrent callers and drops a rejected run", async () => {
  clearMemoCache();
  let runs = 0;
  const slow = () => memoAsync("slow", 1000, async () => { runs++; await Bun.sleep(10); return runs; });
  // Two callers before the first run settles share one execution.
  expect(await Promise.all([slow(), slow()])).toEqual([1, 1]);
  expect(runs).toBe(1);
  expect(await slow()).toBe(1); // cached within the ttl
  expect(runs).toBe(1);

  let attempts = 0;
  const flaky = () => memoAsync("flaky", 1000, async () => { attempts++; if (attempts === 1) throw new Error("transient"); return "ok"; });
  await expect(flaky()).rejects.toThrow("transient");
  expect(await flaky()).toBe("ok"); // failure was not cached
});
