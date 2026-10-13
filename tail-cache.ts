import { closeSync, openSync, readSync, statSync } from "fs";

/** Parse JSONL; a tail read may start mid-line, so malformed lines are skipped. */
export function jsonLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

type Entry = { key: string; lines: any[] };

const cache = new Map<string, Entry>();
const stats = { hits: 0, misses: 0 };
// ponytail: fixed cap; journals rotate so the map cannot grow without bound in practice
const MAX_ENTRIES = 128;

function readTail(path: string, bytes: number, size: number): string {
  const length = Math.min(size, bytes);
  if (length === 0) return "";
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { closeSync(fd); }
}

/**
 * Tail `bytes` of a file and cache the parsed lines keyed by mtime, size and read length.
 * Idle journals (the majority of files on a 1.5s poll) are read once instead of every poll.
 */
export function cachedTailLines(path: string, bytes: number): any[] {
  let size: number;
  let mtime: number;
  try { const st = statSync(path); size = st.size; mtime = st.mtimeMs; } catch { return []; }
  const key = `${mtime}:${size}:${bytes}`;
  const hit = cache.get(path);
  if (hit?.key === key) { stats.hits++; return hit.lines; }
  stats.misses++;
  const lines = jsonLines(readTail(path, bytes, size));
  cache.delete(path); // re-insert so Map order stays least-recently-set first
  if (cache.size >= MAX_ENTRIES) { const oldest = cache.keys().next().value; if (oldest !== undefined) cache.delete(oldest); }
  cache.set(path, { key, lines });
  return lines;
}

export function tailCacheStats() { return { ...stats, size: cache.size }; }
export function clearTailCache() { cache.clear(); stats.hits = 0; stats.misses = 0; }

type TtlEntry = { at: number; value: unknown };
const memoCache = new Map<string, TtlEntry>();
// ponytail: fixed cap; keys are dirs/repos, which are few and stable in practice
const MAX_MEMO = 256;

function remember(key: string, entry: TtlEntry) {
  memoCache.delete(key); // re-insert so Map order stays least-recently-set first
  if (memoCache.size >= MAX_MEMO) { const oldest = memoCache.keys().next().value; if (oldest !== undefined) memoCache.delete(oldest); }
  memoCache.set(key, entry);
}

/** Cached result for `ttlMs`. Expired keys recompute; a throw is never cached. */
export function memo<T>(key: string, ttlMs: number, fn: () => T): T {
  const now = Date.now();
  const hit = memoCache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value as T;
  const value = fn();
  remember(key, { at: now, value });
  return value;
}

/**
 * Cached promise for `ttlMs` with in-flight dedupe: callers that arrive while the first run is
 * still pending share it instead of starting a second one. A rejected run is dropped so the next
 * call retries. Used so the 4 polled endpoints never pay for the same directory scan twice.
 */
export function memoAsync<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = memoCache.get(key);
  if (hit && now - hit.at < ttlMs) return Promise.resolve(hit.value as T);
  const promise = fn();
  remember(key, { at: now, value: promise });
  promise.catch(() => { if (memoCache.get(key)?.value === promise) memoCache.delete(key); });
  return promise;
}

export function clearMemoCache() { memoCache.clear(); }
