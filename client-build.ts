// Prebuilds the client once and caches it on disk, so a cold start does not pay for it.
//
// Bun's HTML import route rebuilds the client at startup and serves an unminified
// ~2.1 MB bundle with the HMR/react-refresh runtime. Prebuilding with Bun.build and
// serving the result from a disk cache gives a minified ~0.7 MB bundle and a server
// that starts without bundling anything. The cache key is the mtime+size of every
// file that can change the bundle, so editing a source file rebuilds once.
import tailwind from "bun-plugin-tailwind";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Directories, and root-level modules, whose contents can change the client bundle. */
const INPUT_DIRS = ["src", "voice"];
const INPUT_FILES = ["package.json", "bun.lock", "bunfig.toml", "tsconfig.json"];
// The client imports root modules as well (src/alerts.ts pulls ../command-stats), so their edits
// have to change the key too. Without this the disk cache keeps serving the previous client.
const ROOT_SOURCE = /\.(ts|tsx|json)$/;
const BASE = "/_client/";

/** Absolute paths of every file that can change the bundle. */
export function clientSources(root: string): string[] {
  const out: string[] = [];
  for (const f of INPUT_FILES) {
    const p = join(root, f);
    if (existsSync(p)) out.push(p);
  }
  try {
    for (const e of readdirSync(root, { withFileTypes: true }))
      if (e.isFile() && ROOT_SOURCE.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(join(root, e.name));
  } catch {} // an unreadable root just means fewer inputs, never a failed startup
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  for (const d of INPUT_DIRS) {
    const p = join(root, d);
    if (existsSync(p)) walk(p);
  }
  return out.sort();
}

/** Cache key: content-relevant metadata of every input, plus the compiler version. */
export function bundleKey(root: string, files: string[] = clientSources(root), bun = Bun.version): string {
  const h = createHash("sha256");
  for (const f of files) {
    let s; try { s = statSync(f); } catch { continue; } // a file that vanished mid-scan adds nothing
    h.update(`${relative(root, f)}:${s.mtimeMs}:${s.size}\n`);
  }
  return h.update(`bun:${bun}\n`).digest("hex").slice(0, 16);
}

export function cacheRoot(): string {
  const home = process.env.XDG_CACHE_HOME || join(process.env.HOME ?? "/tmp", ".cache");
  return join(home, "hubert", "client");
}

/** Assets are flat, hashed filenames in the build dir: no slashes, no traversal. */
export const isAssetName = (name: string) => /^[\w][\w.-]*$/.test(name) && !name.includes("..");

/** The built HTML uses relative refs (`./chunk-x.js`), so it needs a base to resolve them. */
export function withBase(html: string, base: string = BASE): string {
  return html.includes("<base ") ? html : html.replace("<head>", `<head><base href="${base}">`);
}

export type Client = {
  dir: string;
  built: boolean;
  index: () => Response;
  asset: (pathname: string) => Response;
};

type BuildError = { message?: string; position?: { file?: string; line?: number } };

/** " (src/app.tsx:134)" for a build error that knows where it is, else "". */
function where(err: BuildError): string {
  const { file, line } = err.position ?? {};
  return file ? ` (${file}${line ? `:${line}` : ""})` : "";
}

async function build(root: string, dir: string): Promise<boolean> {
  const out = await Bun.build({
    entrypoints: [join(root, "src", "index.html")],
    outdir: dir,
    target: "browser",
    minify: true,
    // Without this everything lands in one chunk and the lazily imported panels are
    // downloaded up front anyway.
    splitting: true,
    plugins: [tailwind],
  });
  if (!out.success) {
    for (const l of out.logs) console.error("[hubert] client build:", String(l));
    return false;
  }
  return existsSync(join(dir, "index.html"));
}

/**
 * Serve the prebuilt client from disk, building it first only when a source file
 * changed. Returns null if the build fails, so the caller can fall back to Bun's
 * dev-server pipeline instead of serving a broken page.
 */
export async function ensureClientBundle(root = import.meta.dir, onWarn = console.error): Promise<Client | null> {
  const dir = join(cacheRoot(), bundleKey(root));
  const fresh = existsSync(join(dir, "ok")) && existsSync(join(dir, "index.html"));
  let built = false;
  if (!fresh) {
    try {
      mkdirSync(dir, { recursive: true });
      const t0 = performance.now();
      if (!(await build(root, dir))) return null;
      writeFileSync(join(dir, "ok"), root + sep);
      built = true;
      onWarn(`[hubert] client bundle built in ${Math.round(performance.now() - t0)} ms -> ${dir}`);
    } catch (e) {
      // Bun.build rejects with an AggregateError whose message is only "Bundle failed"; the real
      // diagnostics live in .errors. Without them a failed build is a blank window and a useless log.
      for (const err of (e as { errors?: BuildError[] }).errors ?? []) onWarn(`[hubert] client build: ${err?.message ?? String(err)}${where(err)}`);
      onWarn(`[hubert] client build failed, using the dev server: ${(e as Error).message}`);
      return null;
    }
  }
  const html = readFileSync(join(dir, "index.html"), "utf8");
  return {
    dir,
    built,
    index: () =>
      new Response(withBase(html, BASE), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      }),
    asset: (pathname: string) => {
      const name = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : "";
      const file = isAssetName(name) ? join(dir, name) : null;
      if (!file || !existsSync(file)) return new Response("not found", { status: 404 });
      // Built filenames are content-hashed, so they can be cached forever.
      return new Response(Bun.file(file), { headers: { "cache-control": "public, max-age=31536000, immutable" } });
    },
  };
}
