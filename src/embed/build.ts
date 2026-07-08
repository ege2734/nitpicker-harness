// nitpicker-harness — provide the browser embed-bridge bundle (src/embed/entry.ts) as a single
// self-contained IIFE, served at EMBED_JS_PATH and loaded by the embed page (inject.ts:embedPage).
//
// Mirrors src/builder/build.ts / src/shell/build.ts: a built package reads the prebuilt
// dist/browser/embed.js (no esbuild at runtime); dev/test falls back to bundling from source with esbuild
// (dynamically imported only on that path). Restart the harness after editing the embed entry.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "entry.ts");
const OUTPUT = "embed.js";

let cached: Promise<string> | null = null;

/** Provide the embed bundle as an IIFE string. Cached for the process lifetime. */
export function buildEmbed(): Promise<string> {
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
