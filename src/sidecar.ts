// nitpicker-harness — spawn the vendored sidecar (vendor/nitpicker/server) under tsx. Shared by the CLI
// (classic `serve` + embedded `serveEmbedded`) and the `startEmbeddedBuilder()` library entrypoint. In
// EMBEDDED mode the sidecar is reused ONLY for its `/blob` image store (the agent channel is the gateway,
// not the queue) — but it is still the same process, spawned the same way, so this stays in one place.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Spawn the vendored sidecar on `port`, forwarding its stdio. */
export function startSidecar(port: number): ChildProcess {
  const server = join(HERE, "..", "vendor", "nitpicker", "server", "index.ts");
  return spawn(process.execPath, [tsxLoader(), server], {
    stdio: "inherit",
    env: { ...process.env, NITPICKER_PORT: String(port) },
  });
}

/** Resolve the tsx ESM loader entry so we can run the vendored TS sidecar with the current node. */
function tsxLoader(): string {
  return join(HERE, "..", "node_modules", "tsx", "dist", "cli.mjs");
}
