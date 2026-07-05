// nitpicker-harness — bundle the browser overlay entry (src/overlay/entry.ts) into a single self-
// contained IIFE, with html2canvas inlined, ready to be served and injected into proxied pages.
//
// In nitpicker's normal (installed) flow the TARGET's bundler (Next/webpack) compiles @nitpicker/core +
// html2canvas. The harness has no such bundler on the target, so it produces the browser bundle itself
// with esbuild. We build once on first request and cache the result in memory (the overlay source is
// static for the process lifetime), so serving it is a hot string write.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "entry.ts");

let cached: Promise<string> | null = null;

/** Bundle the overlay entry into an IIFE string. Cached for the process lifetime. */
export function buildOverlay(): Promise<string> {
  if (!cached) cached = bundle();
  return cached;
}

async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    // The dynamic `import("html2canvas")` inside core/region.ts is inlined into the IIFE by esbuild, so
    // the served bundle is fully self-contained (no code-split chunks to serve).
    minify: true,
    legalComments: "none",
    // core/index.ts probes `process.env.NODE_ENV`; define it so the prod backstop reads "development"
    // (the harness is a dev tool) and never refuses to mount. `typeof process` is still "undefined" in
    // the browser, so this only matters as a safety define.
    define: { "process.env.NODE_ENV": '"development"' },
    write: false,
  });
  return result.outputFiles[0].text;
}
