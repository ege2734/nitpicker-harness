// nitpicker-harness — spawn the vendored sidecar (vendor/nitpicker/server). Shared by the CLI (classic
// `serve` + embedded `serveEmbedded`) and the `startEmbeddedBuilder()` library entrypoint. In EMBEDDED
// mode the sidecar is reused ONLY for its `/blob` image store (the agent channel is the gateway, not the
// queue) — but it is still the same process, spawned the same way, so this stays in one place.
//
// A built package spawns the precompiled `dist/sidecar.js` under plain `node` (NO tsx — that was the
// clean-install break: tsx is a build-only devDependency and its `exports` map doesn't even expose
// `dist/cli.mjs`). Running the TS source under tsx is kept ONLY as the in-repo dev/test fallback.
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Spawn the vendored sidecar on `port`, forwarding its stdio. */
export function startSidecar(port: number): ChildProcess {
  const env = { ...process.env, NITPICKER_PORT: String(port) };

  // Built package: a compiled sidecar bundle sits next to this module (dist/sidecar.js). Run it directly.
  const built = builtSidecar();
  if (built) return spawn(process.execPath, [built], { stdio: "inherit", env });

  // Dev/test fallback: run the vendored TS source under tsx. Resolve tsx via its exported `./cli` subpath
  // (NOT the raw dist path — that isn't in tsx's `exports` and throws under pnpm's isolated layout).
  const server = join(HERE, "..", "vendor", "nitpicker", "server", "index.ts");
  const tsxCli = require.resolve("tsx/cli");
  return spawn(process.execPath, [tsxCli, server], { stdio: "inherit", env });
}

/** Locate the precompiled sidecar bundle, if one exists. Unlike the browser-bundle probes (which must
 *  rebundle from source in-repo so edits aren't masked by a stale dist), the sidecar is a stable vendored
 *  transport, so an in-repo dev/tsx run happily reuses a built `dist/sidecar.js` when present — closer to
 *  the shipped path and faster than the tsx fallback. */
function builtSidecar(): string | null {
  const candidates = [
    join(HERE, "sidecar.js"), // bundled/installed: dist/{cli,index}.js → dist/sidecar.js
    join(HERE, "..", "dist", "sidecar.js"), // in-repo dev/tsx: src/sidecar.ts → <root>/dist/sidecar.js
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}
