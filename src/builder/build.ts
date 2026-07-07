// nitpicker-harness — provide the browser builder bundle (src/builder/entry.ts) as a single self-contained
// IIFE, served at BUILD_JS_PATH and loaded by the builder pane (inject.ts:builderPage).
//
// Mirrors src/shell/build.ts / src/overlay/build.ts: a built package reads the prebuilt
// dist/browser/builder.js (no esbuild at runtime); dev/test falls back to bundling from source with
// esbuild (dynamically imported only on that path). Restart the harness after editing the builder entry.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "entry.ts");
const OUTPUT = "builder.js";

let cached: Promise<string> | null = null;

/** Provide the builder bundle as an IIFE string. Cached for the process lifetime. */
export function buildBuilder(): Promise<string> {
  if (!cached) {
    cached = load().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

function prebuilt(): string | null {
  const candidates = [
    join(HERE, "browser", OUTPUT),
    join(HERE, "..", "..", "dist", "browser", OUTPUT),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
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
