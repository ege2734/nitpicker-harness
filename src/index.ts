// nitpicker-harness — the LIBRARY entrypoint. `startEmbeddedBuilder()` is the composition root Loom drives
// per app (hz-agent §5): it owns the app's dev server (AppRuntime), reuses the sidecar for its `/blob` image
// store, stands up the vendor-agnostic agent backend behind the SSE Agent Gateway, and starts the proxy
// harness with the gateway mounted + the builder pane served. The CLI (`src/cli.ts`) is a thin wrapper over
// this, exactly like `serve()` → `startHarness()` today.
//
// This module re-exports the interfaces Loom consumes so it can `import { … } from "nitpicker-harness"`
// against a single, stable surface. The shapes mirror `@loom/contracts` (AppRuntime, AgentBackend/Session/
// Event, WireItem) so Loom pins this repo and consumes the concrete impl without redeclaring the contract.
import type { ChildProcess } from "node:child_process";
import { startHarness, type Harness } from "./proxy/server";
import { startSidecar } from "./sidecar";
import { LocalAppRuntime, type AppRuntime } from "./app/runtime";
import { makeBackend, type AgentBackend, type AgentSession, type AgentAuth } from "./agent/backend";
import { AgentGateway, type GatewayAuth } from "./agent/gateway";
import { resolveSystemPrompt } from "./agent/system-prompt";

// ---- public interface surface (re-exports) ----
export { startHarness } from "./proxy/server";
export type { Harness, HarnessOptions } from "./proxy/server";
export {
  LocalAppRuntime,
  detectDevCommand,
  type AppRuntime,
  type AppRuntimeStatus,
  type LocalAppRuntimeOptions,
  type DevCommand,
  type DevCommandSource,
} from "./app/runtime";
export {
  makeBackend,
  serializeItem,
  type AgentBackend,
  type AgentSession,
  type AgentSessionOptions,
  type AgentInput,
  type AgentEvent,
  type AgentMessage,
  type AgentAuth,
  type WireItem,
  type QueueItem,
  type BackendOptions,
} from "./agent/backend";
export {
  AgentGateway,
  openAuth,
  bearerAuth,
  AGENT_PREFIX,
  type GatewayAuth,
  type AgentGatewayOptions,
} from "./agent/gateway";
export { formatTurn, formatMark, type FormattedTurn } from "./agent/format";
export { LOOM_BUILDER_SYSTEM_PROMPT, SYSTEM_PROMPT_ENV, resolveSystemPrompt } from "./agent/system-prompt";

export interface EmbeddedBuilderOptions {
  /** The app repo path — the runtime spawns its dev server here and the agent edits here. */
  appPath: string;
  /** Runtime that owns the dev server. Default: a `LocalAppRuntime` over `appPath`. Loom injects a Fleet
   *  runtime that just resolves an already-running `targetUrl`. */
  runtime?: AppRuntime;
  /** Agent backend. Default: `makeBackend("claude")` (in-process Claude Agent SDK). Loom injects its vendor
   *  + auth. Ignored when `noAgent` is set. */
  agent?: AgentBackend;
  /** Port the proxy harness listens on. */
  proxyPort: number;
  /** Build-session id (repo-per-app keyed). Also the primary agent session id + sidecar session. */
  sessionId: string;
  /** Gateway auth. Default: loopback-open (local CLI). Loom injects a bearer/signed-session gate. */
  auth?: GatewayAuth;
  /** Auth injected into the agent backend (api key / oauth) — never hard-coded in a backend. */
  agentAuth?: AgentAuth;
  /** Reused blob store port (images). Assigned to avoid collisions. Default 5178. */
  sidecarPort?: number;
  /** Don't spawn the sidecar (reuse an external one at `sidecarEndpoint`). */
  noSidecar?: boolean;
  /** Sidecar base URL the panes POST blobs to. Default `http://127.0.0.1:<sidecarPort>`. */
  sidecarEndpoint?: string;
  /** Explicit dev command (else detected from package.json). Forwarded to `LocalAppRuntime`. */
  devCommand?: string | string[];
  /** Fixed dev-server port (else the runtime allocates a free one). */
  targetPort?: number;
  /** Model + system framing for the agent. */
  model?: string;
  /** Override the builder-agent system prompt. Precedence (highest first): this value → the
   *  `NITPICKER_HARNESS_SYSTEM_PROMPT` env var → the built-in `LOOM_BUILDER_SYSTEM_PROMPT` default. Loom,
   *  which does NOT set this, gets the shared default persona automatically. */
  systemContext?: string;
  /** Escape hatch: own the dev server but point the pane at the classic sidecar/poll sink (no agent). Keeps
   *  the door open for pocketwatcher-style external drivers from a path. */
  noAgent?: boolean;
  host?: string;
  log?: (m: string) => void;
}

export interface EmbeddedBuilder {
  /** Proxied app (feedback-proxy + builder-shell still available). */
  url: string;
  /** The embedded builder pane Loom iframes/serves as its workspace (or the shell URL under `noAgent`). */
  builderUrl: string;
  /** The builder-shell (queue → sidecar) — always available. */
  shellUrl: string;
  /** The origin of the owned dev server being proxied. */
  targetUrl: string;
  /** The primary agent session (undefined under `noAgent`). */
  session?: AgentSession;
  runtime: AppRuntime;
  gateway?: AgentGateway;
  close(): Promise<void>;
}

/**
 * Stand up embedded-agent mode for one app. Brings the dev server up, mounts the Agent Gateway on the proxy
 * harness, and serves the builder pane — all on one origin/port. Returns handles + a `close()` that tears
 * down the dev server, agent, sidecar, and proxy (the idle→free path).
 */
export async function startEmbeddedBuilder(opts: EmbeddedBuilderOptions): Promise<EmbeddedBuilder> {
  const log = opts.log ?? (() => {});
  const sidecarPort = opts.sidecarPort ?? 5178;
  const endpoint = opts.sidecarEndpoint ?? `http://127.0.0.1:${sidecarPort}`;
  // Every embedded session runs the Loom builder persona unless the caller overrides it (env fallback in
  // between). Resolved ONCE here so the eager primary session and the gateway's lazy sessions agree.
  const systemContext = resolveSystemPrompt(opts.systemContext);

  const runtime =
    opts.runtime ??
    new LocalAppRuntime({
      appDir: opts.appPath,
      devCommand: opts.devCommand,
      port: opts.targetPort,
      log,
    });

  // 1) Bring the app's dev server up (resolves once it answers HTTP).
  const { targetUrl } = await runtime.start();

  // 2) Reuse the sidecar for its /blob image store (embedded mode never uses its queue for the agent).
  let sidecar: ChildProcess | null = null;
  if (!opts.noSidecar) sidecar = startSidecar(sidecarPort);

  // 3) Stand up the agent backend + gateway (unless the caller opted out).
  let gateway: AgentGateway | undefined;
  let session: AgentSession | undefined;
  if (!opts.noAgent) {
    const backend: AgentBackend = opts.agent ?? makeBackend("claude", { model: opts.model });
    gateway = new AgentGateway(backend, {
      cwd: opts.appPath,
      auth: opts.auth,
      systemContext,
      model: opts.model,
      log,
    });
    // Start the primary session eagerly so we can expose the handle; the gateway reuses it for this id.
    session = await backend.startSession({
      cwd: opts.appPath,
      sessionId: opts.sessionId,
      systemContext,
      model: opts.model,
      auth: opts.agentAuth,
    });
    gateway.primeSession(opts.sessionId, session);
  }

  // 4) Start the proxy harness with the gateway mounted + the builder pane served.
  const harness: Harness = await startHarness({
    target: targetUrl,
    port: opts.proxyPort,
    session: opts.sessionId,
    endpoint,
    host: opts.host,
    log,
    mountExtra: gateway?.handler,
    builderPane: !opts.noAgent,
  });

  const shellUrl = `${harness.url}/__nitpicker-harness/shell`;
  const builderUrl = opts.noAgent ? shellUrl : `${harness.url}/__nitpicker-harness/build`;

  return {
    url: harness.url,
    builderUrl,
    shellUrl,
    targetUrl,
    session,
    runtime,
    gateway,
    async close(): Promise<void> {
      await gateway?.close().catch(() => {});
      await session?.close().catch(() => {});
      await harness.close().catch(() => {});
      await runtime.stop().catch(() => {});
      sidecar?.kill();
    },
  };
}
