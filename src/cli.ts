// nitpicker-harness CLI. One command launches the whole thing: the reused nitpicker sidecar (transport
// server) plus the reverse proxy that fronts your target dev server and injects the overlay.
//
//   nitpicker-harness --target http://localhost:3000        start sidecar + proxy (open the printed URL)
//   nitpicker-harness poll --session <id>                   the agent's long-poll for feedback batches
//   nitpicker-harness stop-hook --session <id>              turn-end hook: drives the agent when a mark lands
//   nitpicker-harness pending --session <id>                cheap "is feedback queued?" signal
//   nitpicker-harness health                                check the sidecar is up
//   nitpicker-harness shutdown                              stop the sidecar
//
// The reused sidecar + poll come verbatim from nitpicker (vendor/nitpicker/{server,cli}); the proxy +
// overlay injection are the harness's own code (src/proxy, src/overlay).
import { spawn, type ChildProcess } from "node:child_process";
import { get, request } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startHarness } from "./proxy/server";
import { runPoll } from "../vendor/nitpicker/cli/poll";
import { runStopHook } from "./hook";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SIDECAR_PORT = 5178;
const DEFAULT_PROXY_PORT = 4000;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function usage(): void {
  process.stderr.write(
    `nitpicker-harness — point at a running dev server and mark up feedback for your AI agent.\n\n` +
      `  nitpicker-harness --target <url> [--port <n>] [--session <id>] [--sidecar-port <n>] [--no-sidecar]\n` +
      `  nitpicker-harness poll --session <id> [--endpoint <url>] [--watch]\n` +
      `  nitpicker-harness stop-hook --session <id> [--endpoint <url>] [--timeoutMs <n>]\n` +
      `  nitpicker-harness pending --session <id> [--endpoint <url>]\n` +
      `  nitpicker-harness health [--endpoint <url>]\n` +
      `  nitpicker-harness shutdown [--endpoint <url>]\n\n` +
      `Then open the printed harness URL and use the bottom-center dock (Region / Element / message).\n`,
  );
}

/** Spawn the reused nitpicker sidecar (vendor/nitpicker/server) under tsx, forwarding its stdio. */
function startSidecar(port: number): ChildProcess {
  const server = join(HERE, "..", "vendor", "nitpicker", "server", "index.ts");
  const proc = spawn(process.execPath, [tsxLoader(), server], {
    stdio: "inherit",
    env: { ...process.env, NITPICKER_PORT: String(port) },
  });
  return proc;
}

/** Resolve the tsx ESM loader entry so we can run the vendored TS sidecar with the current node. */
function tsxLoader(): string {
  // `tsx` ships a CLI at node_modules/.bin/tsx; running it via node keeps us off a global `npx` fetch.
  return join(HERE, "..", "node_modules", "tsx", "dist", "cli.mjs");
}

function ping(endpoint: string, path: string, method: "GET" | "POST"): Promise<string> {
  const u = new URL(path, endpoint);
  return new Promise((resolve, reject) => {
    const cb = (res: import("node:http").IncomingMessage): void => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    };
    const req = method === "GET" ? get(u, cb) : request(u, { method }, cb);
    req.on("error", reject);
    if (method === "POST") req.end();
  });
}

async function serve(args: string[]): Promise<void> {
  const target = flag(args, "target");
  if (!target) {
    process.stderr.write("nitpicker-harness: --target <url> is required (e.g. http://localhost:3000)\n\n");
    usage();
    process.exit(1);
  }
  try {
    new URL(target);
  } catch {
    process.stderr.write(`nitpicker-harness: --target is not a valid URL: ${target}\n`);
    process.exit(1);
  }

  const port = Number(flag(args, "port")) || DEFAULT_PROXY_PORT;
  const session = flag(args, "session") || "nitpicker";
  const sidecarPort = Number(flag(args, "sidecar-port")) || DEFAULT_SIDECAR_PORT;
  const endpoint = flag(args, "endpoint") || `http://127.0.0.1:${sidecarPort}`;
  const runSidecar = !has(args, "no-sidecar");

  let sidecar: ChildProcess | null = null;
  if (runSidecar) {
    sidecar = startSidecar(sidecarPort);
    sidecar.on("exit", (code) => {
      if (code && code !== 0) process.stderr.write(`nitpicker-harness: sidecar exited (${code})\n`);
    });
  }

  const harness = await startHarness({ target, port, session, endpoint });

  process.stdout.write(
    `\n  nitpicker-harness ready\n` +
      `  ┌─────────────────────────────────────────────\n` +
      `  │ open:     ${harness.url}\n` +
      `  │ target:   ${target}\n` +
      `  │ sidecar:  ${endpoint}${runSidecar ? "" : "  (external — --no-sidecar)"}\n` +
      `  │ session:  ${session}\n` +
      `  └─────────────────────────────────────────────\n` +
      `  Open the URL above, mark up with the bottom-center dock, then in your agent run:\n` +
      `      nitpicker-harness poll --session ${session}\n\n`,
  );

  const shutdown = (): void => {
    void harness.close();
    sidecar?.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === "-h" || first === "--help") return usage();

  switch (first) {
    case "poll": {
      const session = flag(argv, "session");
      if (!session) {
        process.stderr.write("usage: nitpicker-harness poll --session <id> [--endpoint <url>] [--watch]\n");
        process.exit(1);
      }
      const endpoint = flag(argv, "endpoint") || `http://127.0.0.1:${DEFAULT_SIDECAR_PORT}`;
      return runPoll({
        session,
        endpoint,
        timeoutMs: Number(flag(argv, "timeoutMs")) || 0,
        watch: has(argv, "watch"),
      });
    }
    case "stop-hook": {
      // Turn-end hook: parks on the sidecar and, when a mark lands, emits a Claude-Code block decision
      // that re-invokes the agent to drain. See src/hook.ts and SKILL.md "Keep the agent driven".
      const session = flag(argv, "session");
      if (!session) {
        process.stderr.write("usage: nitpicker-harness stop-hook --session <id> [--endpoint <url>] [--timeoutMs <n>]\n");
        process.exit(1);
      }
      const endpoint = flag(argv, "endpoint") || `http://127.0.0.1:${DEFAULT_SIDECAR_PORT}`;
      // 0 => park indefinitely; the Claude-Code hook `timeout` is the real wall-clock bound.
      return runStopHook({ session, endpoint, timeoutMs: Number(flag(argv, "timeoutMs")) || 0 });
    }
    case "pending": {
      const session = flag(argv, "session");
      if (!session) {
        process.stderr.write("usage: nitpicker-harness pending --session <id> [--endpoint <url>]\n");
        process.exit(1);
      }
      const endpoint = flag(argv, "endpoint") || `http://127.0.0.1:${DEFAULT_SIDECAR_PORT}`;
      process.stdout.write((await ping(endpoint, `/pending?session=${encodeURIComponent(session)}`, "GET")) + "\n");
      return;
    }
    case "health": {
      const endpoint = flag(argv, "endpoint") || `http://127.0.0.1:${DEFAULT_SIDECAR_PORT}`;
      process.stdout.write((await ping(endpoint, "/health", "GET")) + "\n");
      return;
    }
    case "shutdown": {
      const endpoint = flag(argv, "endpoint") || `http://127.0.0.1:${DEFAULT_SIDECAR_PORT}`;
      process.stdout.write((await ping(endpoint, "/shutdown", "POST")) + "\n");
      return;
    }
    default:
      // No subcommand → serve (flags like --target live here).
      return serve(argv);
  }
}

void main().catch((err) => {
  process.stderr.write(`nitpicker-harness: ${(err as Error).message}\n`);
  process.exit(1);
});
