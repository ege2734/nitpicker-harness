// nitpicker-harness — provide the browser overlay bundle (src/overlay/entry.ts) as a single self-
// contained IIFE, served and injected into proxied pages.
//
// In a built package the bundle is produced ahead of time by scripts/build.mjs into dist/browser/overlay.js
// and simply read from disk here — so a clean consumer install needs NO esbuild/html2canvas at runtime.
// In dev/test (running the TS source under tsx/vitest, no dist) we fall back to bundling from source with
// esbuild, so the source stays the single source of truth. esbuild is dynamically imported ONLY on that
// fallback, keeping it a build-only devDependency.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "entry.ts");

let cached: Promise<string> | null = null;

/** Bundle name under dist/browser/. */
const OUTPUT = "overlay.js";

/** Provide the overlay bundle as an IIFE string. Cached for the process lifetime. */
export function buildOverlay(): Promise<string> {
  if (!cached) {
    cached = load().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

/** Prebuilt bundle location: next to the running bundle (dist/browser/…) in a built package.
 *  Hit → serve it; miss (dev tsx from source) → esbuild from source. */
function prebuilt(): string | null {
  const file = join(HERE, "browser", OUTPUT); // bundled: dist/{cli,index}.js → dist/browser/<OUTPUT>
  return existsSync(file) ? file : null;
}

async function load(): Promise<string> {
  const file = prebuilt();
  if (file) return readFile(file, "utf8");
  return bundleFromSource();
}

async function bundleFromSource(): Promise<string> {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    // The dynamic `import("html2canvas-pro")` inside core/region.ts is inlined into the IIFE by esbuild, so
    // the served bundle is fully self-contained (no code-split chunks to serve).
    minify: true,
    legalComments: "none",
    // core/index.ts probes `process.env.NODE_ENV`; define it so the prod backstop reads "development"
    // (the harness is a dev tool) and never refuses to mount.
    define: { "process.env.NODE_ENV": '"development"' },
    write: false,
  });
  return result.outputFiles[0].text;
}
