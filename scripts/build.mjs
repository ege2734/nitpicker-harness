// nitpicker-harness — the build. Produces a runnable, tsx-free `dist/` so the package works from a clean
// consumer install (npm/pnpm/yarn, git-dependency, or published tarball) with NO dev deps present.
//
// Two kinds of output (esbuild does both):
//   1. Server bundles (platform=node, ESM, third-party packages left EXTERNAL so node resolves them from
//      the consumer's node_modules at runtime):
//        - dist/cli.js      the CLI entry (bin runs this)
//        - dist/index.js    the library entry (`startEmbeddedBuilder` + interface re-exports)
//        - dist/sidecar.js  the vendored transport sidecar (spawned as `node dist/sidecar.js` — never tsx)
//   2. Browser bundles (platform=browser, IIFE, fully self-contained — html2canvas inlined):
//        - dist/browser/overlay.js   injected feedback overlay
//        - dist/browser/shell.js     builder-shell parent chrome
//        - dist/browser/builder.js   embedded builder pane
//      These are served verbatim by the proxy at runtime (src/*/build.ts prefers the prebuilt file and only
//      falls back to esbuild-from-source in dev/test), so esbuild + html2canvas are BUILD-only devDeps.
//
// Type declarations (dist/types/**) are emitted separately by `tsc -p tsconfig.build.json` (npm run build).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rm, mkdir } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = join(ROOT, "dist");
const src = (...p) => join(ROOT, "src", ...p);
const vendor = (...p) => join(ROOT, "vendor", "nitpicker", ...p);

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(join(DIST, "browser"), { recursive: true });

  // ---- server bundles (node, ESM, deps external) ----
  // packages:"external" keeps every bare import (http-proxy, node builtins, the optional Claude Agent SDK)
  // as a runtime import resolved from the consumer's node_modules. Only relative src/ + vendor/ code is
  // inlined. import.meta.url in each bundle points at dist/<name>.js, which is what sidecar.ts / *build.ts
  // rely on to locate their sibling artifacts.
  await build({
    entryPoints: {
      cli: src("cli.ts"),
      index: src("index.ts"),
      sidecar: vendor("server", "index.ts"),
    },
    outdir: DIST,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    packages: "external",
    sourcemap: true,
    logLevel: "info",
  });

  // ---- browser bundles (IIFE, self-contained) ----
  const browser = (entry, outfile, define) =>
    build({
      entryPoints: [entry],
      outfile: join(DIST, "browser", outfile),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2020",
      minify: true,
      legalComments: "none",
      ...(define ? { define } : {}),
      logLevel: "info",
    });

  await Promise.all([
    // The overlay probes process.env.NODE_ENV in core/index.ts; define it so the prod backstop never
    // refuses to mount (matches src/overlay/build.ts). shell/builder don't need the define.
    browser(src("overlay", "entry.ts"), "overlay.js", { "process.env.NODE_ENV": '"development"' }),
    browser(src("shell", "entry.ts"), "shell.js"),
    browser(src("builder", "entry.ts"), "builder.js"),
  ]);

  process.stdout.write("nitpicker-harness: build complete → dist/\n");
}

main().catch((err) => {
  process.stderr.write(`nitpicker-harness build failed: ${err.stack || err}\n`);
  process.exit(1);
});
