// nitpicker-harness — provide the browser shell bundle (src/shell/entry.ts) as a single self-contained
// IIFE, served at SHELL_JS_PATH and loaded by the parent shell page (inject.ts:shellPage).
//
// Mirrors src/overlay/build.ts: in a built package the bundle is produced ahead of time by
// scripts/build.mjs into dist/browser/shell.js and read from disk (no esbuild/html2canvas at runtime);
// in dev/test we fall back to bundling from source with esbuild (dynamically imported only on that path).
// Restart the harness after editing the shell entry — a reload alone serves the stale cached bundle.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "entry.ts");
const OUTPUT = "shell.js";

let cached: Promise<string> | null = null;

/** Provide the shell bundle as an IIFE string. Cached for the process lifetime. */
export function buildShell(): Promise<string> {
  if (!cached) {
    cached = load().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

function prebuilt(): string | null {
  const file = join(HERE, "browser", OUTPUT);
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
    minify: true,
    legalComments: "none",
    write: false,
  });
  return result.outputFiles[0].text;
}
