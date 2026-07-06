// nitpicker-harness — bundle the browser shell entry (src/shell/entry.ts) into a single self-contained
// IIFE, served at SHELL_JS_PATH and loaded by the parent shell page (inject.ts:shellPage). Mirrors
// src/overlay/build.ts: the harness has no bundler on the target, so esbuild produces the browser bundle
// here and caches it in memory for the process lifetime (the source is static). Restart the harness after
// editing the shell entry — a reload alone serves the stale cached bundle (same rule as the overlay).
//
// This bundle is small: Phase 1 reuses only vendor/nitpicker/core/{transport,types}.ts (chat + queue +
// send-to-sidecar). No html2canvas / DOM-capture engine yet — those arrive in Phase 2.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "entry.ts");

let cached: Promise<string> | null = null;

/** Bundle the shell entry into an IIFE string. Cached for the process lifetime. */
export function buildShell(): Promise<string> {
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
