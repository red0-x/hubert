import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleKey, cacheRoot, clientSources, ensureClientBundle, isAssetName, withBase } from "./client-build";

let root = "";
const originalCache = process.env.XDG_CACHE_HOME;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hubert-client-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(root, "src", "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="./app.css" /></head><body><div id="root"></div><script type="module" src="./app.ts"></script></body></html>');
  writeFileSync(join(root, "src", "app.ts"), 'console.log("hubert fixture");\n');
  writeFileSync(join(root, "src", "app.css"), "body { color: red }\n");
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "hubert-cache-"));
});

afterAll(() => {
  const cache = process.env.XDG_CACHE_HOME;
  if (originalCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCache;
  rmSync(root, { recursive: true, force: true });
  if (cache) rmSync(cache, { recursive: true, force: true });
});

describe("client bundle cache", () => {
  test("withBase adds one base tag, only when missing", () => {
    const once = withBase("<html><head><title>x</title></head></html>", "/_client/");
    expect(once).toContain('<base href="/_client/">');
    expect(withBase(once, "/_client/")).toBe(once);
  });

  test("asset names are flat and cannot walk out of the build dir", () => {
    expect(isAssetName("chunk-abc123.js")).toBe(true);
    expect(isAssetName("app.css")).toBe(true);
    for (const bad of ["", "../package.json", "a/b.js", "..", "..%2f"]) expect(isAssetName(bad)).toBe(false);
  });

  test("key covers every input file and follows mtimes", () => {
    const files = clientSources(root);
    expect(files.some((f) => f.endsWith(join("src", "app.ts")))).toBe(true);
    expect(files.some((f) => f.endsWith("package.json"))).toBe(true);
    const key = bundleKey(root, files);
    expect(bundleKey(root, files)).toBe(key);
    expect(bundleKey(root, files, "9.9.9")).not.toBe(key);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "src", "app.ts"), later, later);
    expect(bundleKey(root, clientSources(root))).not.toBe(key);
  });

  test("builds once, caches on disk, and serves html plus assets", async () => {
    const first = await ensureClientBundle(root, () => {});
    expect(first).not.toBeNull();
    expect(first!.built).toBe(true);
    const html = await first!.index().text();
    expect(html).toContain('/_client/');
    const js = /src="\.\/([^"]+\.js)"/.exec(html)?.[1];
    expect(js).toBeTruthy();
    const asset = first!.asset(`/_client/${js}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await asset.text()).length).toBeGreaterThan(0);
    expect(first!.asset("/_client/../package.json").status).toBe(404);
    expect(first!.asset("/_client/missing.js").status).toBe(404);

    const cached = await ensureClientBundle(root, () => {});
    expect(cached!.dir).toBe(first!.dir);
    expect(cached!.built).toBe(false); // nothing changed: no rebuild

    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "src", "app.ts"), later, later);
    const rebuilt = await ensureClientBundle(root, () => {});
    expect(rebuilt!.dir).not.toBe(first!.dir);
    expect(rebuilt!.built).toBe(true);
  });

  test("cache lives under hubert/client", () => {
    expect(cacheRoot().endsWith(join("hubert", "client"))).toBe(true);
  });
});
