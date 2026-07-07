// nitpicker-harness CLI. One command launches the whole thing: the vendored sidecar (transport server)
// plus the reverse proxy that fronts your target dev server and injects the overlay.
//
//   nitpicker-harness <path-to-app>                         EMBEDDED: own the app's dev server + a live agent
//   nitpicker-harness --target http://localhost:3000        start sidecar + proxy (open the printed URL)
//   nitpicker-harness poll --session <id>                   the agent's long-poll for feedback batches
//   nitpicker-harness stop-hook --session <id>              turn-end hook: drives the agent when a mark lands
//   nitpicker-harness pending --session <id>                cheap "is feedback queued?" signal
//   nitpicker-harness health                                check the sidecar is up
//   nitpicker-harness shutdown                              stop the sidecar
//
// The sidecar + poll live under vendor/nitpicker/{server,cli}; the proxy + overlay injection are the
// harness's own code (src/proxy, src/overlay). Embedded mode's composition is the `startEmbeddedBuilder()`
// library (src/index.ts); this CLI is a thin wrapper over it.
import type { ChildProcess } from "node:child_process";
import { get, request } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startHarness } from "./proxy/server";
import { startSidecar } from "./sidecar";
import { startEmbeddedBuilder } from "./index";
import { makeBackend } from "./agent/backend";
import { bearerAuth } from "./agent/gateway";
import { runPoll } from "../vendor/nitpicker/cli/poll";
import { runStopHook } from "./hook";

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
      `  nitpicker-harness <path-to-app> [--dev-cmd "<cmd>"] [--target-port <n>] [--port <n>]\n` +
      `                                  [--session <id>] [--agent claude|claude-cli] [--no-agent]\n` +
      `                                  [--system-prompt <file>]\n` +
      `  nitpicker-harness --target <url> [--port <n>] [--session <id>] [--sidecar-port <n>] [--no-sidecar]\n` +
      `  nitpicker-harness poll --session <id> [--endpoint <url>] [--watch]\n` +
      `  nitpicker-harness stop-hook --session <id> [--endpoint <url>] [--timeoutMs <n>]\n` +
      `  nitpicker-harness pending --session <id> [--endpoint <url>]\n` +
      `  nitpicker-harness health [--endpoint <url>]\n` +
      `  nitpicker-harness shutdown [--endpoint <url>]\n\n` +
      `Embedded mode (a bare path): the harness owns the app's dev server and the side pane IS a live agent.\n` +
      `  An explicit --dev-cmd MUST bind the injected $PORT (e.g. "uvicorn app:app --reload --port $PORT"),\n` +
      `  or pass --target-port matching the port the command binds, else readiness detection times out.\n` +
      `  The agent runs the Loom builder persona by default; override with --system-prompt <file> or the\n` +
      `  NITPICKER_HARNESS_SYSTEM_PROMPT env var.\n` +
      `Target mode (--target): point at an already-running server; mark up with the dock / builder shell.\n`,
  );
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
      `  │ shell:    ${harness.url}/__nitpicker-harness/shell\n` +
      `  │ target:   ${target}\n` +
      `  │ sidecar:  ${endpoint}${runSidecar ? "" : "  (external — --no-sidecar)"}\n` +
      `  │ session:  ${session}\n` +
      `  └─────────────────────────────────────────────\n` +
      `  • Feedback-proxy mode: open the app URL and mark up with the bottom-center dock.\n` +
      `  • Builder-shell mode:  open the shell URL — persistent chat + queue in a parent frame.\n` +
      `  Then in your agent run:\n` +
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

/** Embedded mode: own the app's dev server (from a path) and host a live agent in the side pane. Thin
 *  wrapper over the `startEmbeddedBuilder()` library. */
async function serveEmbedded(args: string[], appPathArg: string): Promise<void> {
  const appPath = resolve(appPathArg);
  const proxyPort = Number(flag(args, "port")) || DEFAULT_PROXY_PORT;
  const sessionId = flag(args, "session") || "nitpicker";
  const sidecarPort = Number(flag(args, "sidecar-port")) || DEFAULT_SIDECAR_PORT;
  const endpoint = flag(args, "endpoint") || `http://127.0.0.1:${sidecarPort}`;
  const devCommand = flag(args, "dev-cmd");
  const targetPortRaw = flag(args, "target-port");
  const targetPort = targetPortRaw ? Number(targetPortRaw) : undefined;
  const model = flag(args, "model");
  const noAgent = has(args, "no-agent");
  const noSidecar = has(args, "no-sidecar");
  const agentName = flag(args, "agent") || "claude";
  const token = flag(args, "agent-token");
  // `--system-prompt <file>` overrides the built-in Loom builder persona; its contents win over the
  // NITPICKER_HARNESS_SYSTEM_PROMPT env var and the default (resolveSystemPrompt handles precedence).
  const systemPromptFile = flag(args, "system-prompt");
  let systemContext: string | undefined;
  if (systemPromptFile) {
    try {
      systemContext = readFileSync(resolve(systemPromptFile), "utf8");
    } catch (err) {
      process.stderr.write(
        `nitpicker-harness: cannot read --system-prompt file ${systemPromptFile}: ${(err as Error).message}\n`,
      );
      process.exit(1);
    }
  }

  const agent = noAgent ? undefined : makeBackend(agentName, { model });
  const auth = token ? bearerAuth(token) : undefined;

  const builder = await startEmbeddedBuilder({
    appPath,
    proxyPort,
    sessionId,
    sidecarPort,
    sidecarEndpoint: endpoint,
    noSidecar,
    devCommand,
    targetPort,
    model,
    systemContext,
    noAgent,
    agent,
    auth,
    log: (m) => process.stdout.write(m.endsWith("\n") ? m : m + "\n"),
  });

  process.stdout.write(
    `\n  nitpicker-harness ready ${noAgent ? "(embedded, --no-agent)" : "(embedded agent)"}\n` +
      `  ┌─────────────────────────────────────────────\n` +
      `  │ open:     ${builder.url}\n` +
      `  │ builder:  ${builder.builderUrl}\n` +
      `  │ shell:    ${builder.shellUrl}\n` +
      `  │ app:      ${appPath}\n` +
      `  │ target:   ${builder.targetUrl}  (owned dev server)\n` +
      `  │ sidecar:  ${endpoint}${noSidecar ? "  (external — --no-sidecar)" : ""}\n` +
      `  │ session:  ${sessionId}\n` +
      `  └─────────────────────────────────────────────\n` +
      (noAgent
        ? `  • --no-agent: the pane uses the classic sidecar/poll sink. Drain with:\n` +
          `      nitpicker-harness poll --session ${sessionId}\n\n`
        : `  • Open the builder URL: chat with the agent + mark up the live preview in one pane.\n\n`),
  );

  const shutdown = (): void => {
    void builder.close().finally(() => process.exit(0));
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
    default: {
      // A bare positional path (or --app <path>) selects EMBEDDED mode; `--target <url>` stays classic.
      // The two are mutually exclusive: an explicit --target always wins (never treat it as embedded).
      const appPath = flag(argv, "app") ?? (first && !first.startsWith("-") ? first : undefined);
      if (appPath && !has(argv, "target")) return serveEmbedded(argv, appPath);
      return serve(argv);
    }
  }
}

void main().catch((err) => {
  process.stderr.write(`nitpicker-harness: ${(err as Error).message}\n`);
  process.exit(1);
});
