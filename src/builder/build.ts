// nitpicker-harness — bundle the browser builder entry (src/builder/entry.ts) into a single self-contained
// IIFE, served at BUILD_JS_PATH and loaded by the builder pane (inject.ts:builderPage). Mirrors
// src/shell/build.ts / src/overlay/build.ts: esbuild produces the browser bundle here and caches it in
// memory for the process lifetime. Restart the harness after editing the builder entry — a reload alone
// serves the stale cached bundle (same rule as the overlay/shell bundles).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "entry.ts");

let cached: Promise<string> | null = null;

/** Bundle the builder entry into an IIFE string. Cached for the process lifetime. */
export function buildBuilder(): Promise<string> {
  if (!cached) {
    cached = bundle().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "none",
    write: false,
  });
  return result.outputFiles[0].text;
}
