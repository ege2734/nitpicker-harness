// nitpicker-harness — the vendor-agnostic agent-backend contract for EMBEDDED mode (hz-agent §4,
// loom-decision D7). This is the seam Loom consumes: a build session rooted at the app repo that runs
// ONE turn at a time as `send(input) -> AsyncIterable<AgentEvent>`, streamed to the pane over the Agent
// Gateway's SSE channel (src/agent/gateway.ts). Claude/Codex/etc. slot in behind `AgentBackend`.
//
// The interface shapes are kept BYTE-COMPATIBLE with `@loom/contracts` (`packages/contracts/src/agent.ts`)
// so Loom pins this repo and consumes the concrete impl without re-declaring the contract. If you diverge
// from those names/types, update @loom/contracts in lockstep (or the pin breaks).
//
// This module is pure interface + a tiny registry — importing it pulls in NO agent SDK. The reference
// backend (claude-backend.ts) is statically imported here but dynamic-imports the Claude Agent SDK only
// when a session actually runs, so the harness (and its tests) never hard-depend on the SDK being present.
import { serializeItem, type QueueItem } from "../../vendor/nitpicker/core/types";
import { ClaudeBackend } from "./claude-backend";

/** A mark on the wire — exactly what `serializeItem()` produces (a `QueueItem` minus the four client-only
 *  `_`-prefixed fields). Re-exported here as the shared name Loom's `@loom/contracts` mirrors. */
export type WireItem = ReturnType<typeof serializeItem>;
export { serializeItem };
export type { QueueItem };

/** Auth is injected by Loom per session — NEVER hard-coded in a backend. Opaque + short-lived. */
export interface AgentAuth {
  kind: "anthropic-api-key" | "oauth" | "none";
  /** Materialized by the platform, not stored here. */
  token?: string;
}

export interface AgentSessionOptions {
  /** The app repo path — the agent edits here. */
  cwd: string;
  sessionId: string;
  /** Rehydrate a prior transcript if the backend supports it. */
  resume?: boolean;
  /** Harness-supplied framing ("you are the builder for this app; …"). */
  systemContext?: string;
  model?: string;
  auth?: AgentAuth;
}

export interface AgentInput {
  text?: string;
  /** Harness marks composed into this turn (element/region/text-edit/message). */
  marks?: WireItem[];
}

/** Streamed turn output. Matches `@loom/contracts` `AgentEvent` verbatim. */
export type AgentEvent =
  | { type: "turn_start" }
  | { type: "token"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean; summary?: string }
  /** A file changed; the pane badges it — the preview HMRs on its own. */
  | { type: "file_changed"; path: string }
  | { type: "turn_end"; ok: boolean }
  | { type: "error"; message: string };

export interface AgentMessage {
  role: "user" | "assistant";
  text: string;
  marks?: WireItem[];
}

export interface AgentSession {
  readonly id: string;
  /** Run ONE turn. Streams events until `turn_end`. `interrupt()` cancels it. */
  send(input: AgentInput): AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  /** Transcript for rehydration (drives `GET /agent/history`). */
  history(): AgentMessage[];
  close(): Promise<void>;
}

export interface AgentBackend {
  readonly id: string;
  /** Open (or resume) a session rooted at the app repo. */
  startSession(opts: AgentSessionOptions): Promise<AgentSession>;
}

/** Options a `makeBackend` factory forwards to the concrete backend constructor. */
export interface BackendOptions {
  /** Force the CLI-spawn path (`claude -p …`) even for the in-process default. */
  cli?: boolean;
  /** Model id override applied to every session unless the session opts override it. */
  model?: string;
}

/**
 * Backend registry. `makeBackend("claude")` → the in-process Claude Agent SDK reference backend;
 * `makeBackend("claude-cli")` (or `{ cli: true }`) → the `claude -p --output-format stream-json` spawn
 * fallback. Unknown names throw — a Loom deployment injects its own `AgentBackend` directly instead.
 *
 * The concrete backend module is imported lazily so this registry (and the gateway that uses it) carries
 * no static dependency on the agent SDK.
 */
export function makeBackend(name: string, opts: BackendOptions = {}): AgentBackend {
  const cli = opts.cli || name === "claude-cli";
  switch (name === "claude-cli" ? "claude" : name) {
    case "claude":
    case "claude-code":
      return new ClaudeBackend({ cli, model: opts.model });
    default:
      throw new Error(
        `nitpicker-harness: unknown agent backend "${name}" (known: claude, claude-cli). ` +
          `Loom injects a custom AgentBackend instead of naming one.`,
      );
  }
}
