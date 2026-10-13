import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleKey, clientSources, ensureClientBundle } from "./client-build";

function fixture(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "hubert-client-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"fixture"}');
  writeFileSync(join(root, "src", "index.html"), '<!doctype html><html><head></head><body><script type="module" src="./app.ts"></script></body></html>');
  writeFileSync(join(root, "src", "app.ts"), 'console.log("hubert fixture");\n');
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(root, name), body);
  return root;
}

// A prebuild failure used to log only "Bundle failed", so a syntax error in the client looked like a
// blank window with nothing in the log. The real diagnostics (Bun's AggregateError.errors) must show.

test("a broken client source is reported with the error and its location", async () => {
  const root = fixture();
  const cache = mkdtempSync(join(tmpdir(), "hubert-broken-cache-"));
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  try {
    writeFileSync(join(root, "src", "app.ts"), "export const broken = ;\n");
    const warnings: string[] = [];
    const client = await ensureClientBundle(root, (m) => warnings.push(String(m)));
    const log = warnings.join("\n");
    expect(client).toBeNull();
    expect(log).toContain("app.ts"); // which file
    expect(log).toMatch(/Expected|Unexpected|error/i); // and what is wrong with it
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("root modules the client imports are part of the bundle key", () => {
  const root = fixture({ "command-stats.ts": "export const retryLoops = () => [];\n" });
  try {
    const files = clientSources(root);
    expect(files.some((f) => f.endsWith(join("command-stats.ts")))).toBe(true); // src/alerts.ts imports this
    const key = bundleKey(root, files);
    // An edit there must rebuild, or the disk cache keeps serving the previous client.
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "command-stats.ts"), later, later);
    expect(bundleKey(root, clientSources(root))).not.toBe(key);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a test file at the root does not force a rebuild", () => {
  const root = fixture({ "state.test.ts": "// changes often, never bundled\n" });
  try {
    expect(clientSources(root).some((f) => f.endsWith("state.test.ts"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
