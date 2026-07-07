// nitpicker-harness — the REFERENCE agent backend: Claude, in-process via the Claude Agent SDK
// (`@anthropic-ai/claude-agent-sdk`), with a `claude -p --output-format stream-json` CLI-spawn fallback
// (hz-agent §4, loom-decision D7). Maps the SDK's streamed messages onto `AsyncIterable<AgentEvent>`, the
// exact shape the gateway streams to the pane over SSE.
//
// The SDK is imported DYNAMICALLY (a non-literal specifier), so this module — and everything that imports
// the backend registry — carries no static dependency on the SDK. The package is declared as an OPTIONAL
// dependency: present in real installs (Loom), absent-tolerant in CI. A session only touches the SDK when
// `send()` is first driven; unit tests exercise the gateway with a fake backend and never load it.
import { spawn, type ChildProcess } from "node:child_process";
import { formatTurn } from "./format";
import type {
  AgentBackend,
  AgentEvent,
  AgentInput,
  AgentMessage,
  AgentSession,
  AgentSessionOptions,
} from "./backend";

// Non-literal so TypeScript cannot resolve (and thus does not require) the module at check time — the
// import is a genuine runtime-only, optional dependency. Kept as a `string`-typed const on purpose.
const SDK_MODULE: string = "@anthropic-ai/claude-agent-sdk";

/** How the harness asks the agent to open a region screenshot it references by path. */
const IMAGE_HINT =
  "Screenshots referenced above are local files — open them with the Read tool to see the marked region.";

export class ClaudeBackend implements AgentBackend {
  readonly id: string;
  constructor(private readonly opts: { cli?: boolean; model?: string } = {}) {
    this.id = opts.cli ? "claude-cli" : "claude";
  }

  async startSession(opts: AgentSessionOptions): Promise<AgentSession> {
    const model = opts.model ?? this.opts.model;
    return this.opts.cli
      ? new ClaudeCliSession({ ...opts, model })
      : new ClaudeSdkSession({ ...opts, model });
  }
}

/** Shared transcript bookkeeping for both the SDK and CLI sessions. */
abstract class BaseClaudeSession implements AgentSession {
  readonly id: string;
  protected readonly transcript: AgentMessage[] = [];
  protected running = false;
  constructor(protected readonly opts: AgentSessionOptions) {
    this.id = opts.sessionId;
  }
  history(): AgentMessage[] {
    return this.transcript.slice();
  }
  abstract send(input: AgentInput): AsyncIterable<AgentEvent>;
  abstract interrupt(): Promise<void>;
  abstract close(): Promise<void>;

  /** Record the user turn + build the composed prompt. Returns the prompt to feed the model. */
  protected beginTurn(input: AgentInput): string {
    this.transcript.push({ role: "user", text: input.text ?? "", marks: input.marks });
    const { prompt, imagePaths } = formatTurn(input);
    return imagePaths.length ? `${prompt}\n\n${IMAGE_HINT}` : prompt;
  }

  /** Record the assistant turn from the accumulated token text. */
  protected endTurn(assistantText: string): void {
    this.transcript.push({ role: "assistant", text: assistantText });
  }

  /** Auth: the SDK/CLI read `ANTHROPIC_API_KEY` from the environment. Inject the per-session token there,
   *  never on a command line. `oauth`/`none` fall through to the ambient login the CLI already holds. */
  protected childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (this.opts.auth?.kind === "anthropic-api-key" && this.opts.auth.token) {
      env.ANTHROPIC_API_KEY = this.opts.auth.token;
    }
    return env;
  }
}

/** In-process backend over `@anthropic-ai/claude-agent-sdk`'s `query()`. */
class ClaudeSdkSession extends BaseClaudeSession {
  private query: { interrupt?: () => void } | null = null;

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    if (this.running) {
      yield { type: "error", message: "a turn is already in flight" };
      return;
    }
    this.running = true;
    yield { type: "turn_start" };
    let assistant = "";
    let ok = true;
    try {
      const sdk = (await import(SDK_MODULE)) as {
        query: (p: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<SdkMessage> & {
          interrupt?: () => void;
        };
      };
      // Materialize auth into the environment for the duration of the turn.
      const restore = this.applyAuthEnv();
      const q = sdk.query({
        prompt: this.beginTurn(input),
        options: {
          cwd: this.opts.cwd,
          ...(this.opts.model ? { model: this.opts.model } : {}),
          ...(this.opts.resume ? { resume: this.opts.sessionId } : {}),
          ...(this.opts.systemContext ? { appendSystemPrompt: this.opts.systemContext } : {}),
          // The builder agent edits the app repo autonomously inside the sandbox.
          permissionMode: "bypassPermissions",
        },
      });
      this.query = q;
      try {
        for await (const msg of q) {
          for (const ev of mapSdkMessage(msg)) {
            if (ev.type === "token") assistant += ev.text;
            if (ev.type === "turn_end") ok = ev.ok;
            if (ev.type !== "turn_end") yield ev;
          }
        }
      } finally {
        restore();
      }
    } catch (err) {
      ok = false;
      yield { type: "error", message: sdkErrorMessage(err) };
    } finally {
      this.query = null;
      this.running = false;
      this.endTurn(assistant);
    }
    yield { type: "turn_end", ok };
  }

  async interrupt(): Promise<void> {
    try {
      this.query?.interrupt?.();
    } catch {
      /* best-effort */
    }
  }

  async close(): Promise<void> {
    await this.interrupt();
  }

  /** Set ANTHROPIC_API_KEY on `process.env` for the in-process SDK call; returns a restorer. */
  private applyAuthEnv(): () => void {
    if (this.opts.auth?.kind !== "anthropic-api-key" || !this.opts.auth.token) return () => {};
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = this.opts.auth.token;
    return () => {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    };
  }
}

/** Fallback backend: spawn `claude -p --output-format stream-json` and parse its NDJSON stream. */
class ClaudeCliSession extends BaseClaudeSession {
  private child: ChildProcess | null = null;

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    if (this.running) {
      yield { type: "error", message: "a turn is already in flight" };
      return;
    }
    this.running = true;
    yield { type: "turn_start" };
    const prompt = this.beginTurn(input);
    let assistant = "";
    let ok = true;
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ];
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.resume) args.push("--resume", this.opts.sessionId);

    const child = spawn("claude", args, { cwd: this.opts.cwd, env: this.childEnv() });
    this.child = child;
    try {
      for await (const line of readLines(child)) {
        let msg: SdkMessage;
        try {
          msg = JSON.parse(line) as SdkMessage;
        } catch {
          continue; // non-JSON diagnostic line
        }
        for (const ev of mapSdkMessage(msg)) {
          if (ev.type === "token") assistant += ev.text;
          if (ev.type === "turn_end") ok = ev.ok;
          if (ev.type !== "turn_end") yield ev;
        }
      }
      const code = await onExit(child);
      if (code !== 0 && ok) {
        ok = false;
        yield { type: "error", message: `claude CLI exited with code ${code}` };
      }
    } catch (err) {
      ok = false;
      yield { type: "error", message: (err as Error).message };
    } finally {
      this.child = null;
      this.running = false;
      this.endTurn(assistant);
    }
    yield { type: "turn_end", ok };
  }

  async interrupt(): Promise<void> {
    this.child?.kill("SIGINT");
  }

  async close(): Promise<void> {
    this.child?.kill();
  }
}

// ---- SDK/CLI message → AgentEvent mapping (best-effort; both share the stream-json shape) ----

interface SdkContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}
interface SdkMessage {
  type: string;
  subtype?: string;
  is_error?: boolean;
  message?: { content?: SdkContentBlock[] };
  result?: string;
}

/** Map one streamed SDK/CLI message to zero or more `AgentEvent`s. */
export function mapSdkMessage(msg: SdkMessage): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (msg.type === "assistant") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text" && block.text) {
        out.push({ type: "token", text: block.text });
      } else if (block.type === "tool_use" && block.name) {
        out.push({ type: "tool_use", name: block.name, input: block.input });
        const path = editedFilePath(block.name, block.input);
        if (path) out.push({ type: "file_changed", path });
      }
    }
  } else if (msg.type === "result") {
    out.push({ type: "turn_end", ok: !msg.is_error });
  }
  return out;
}

/** The file a filesystem-mutating tool touched, for the `file_changed` pane badge. */
function editedFilePath(tool: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const edits = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Create", "Update"]);
  if (!edits.has(tool)) return null;
  const rec = input as Record<string, unknown>;
  const p = rec.file_path ?? rec.path ?? rec.notebook_path;
  return typeof p === "string" ? p : null;
}

function sdkErrorMessage(err: unknown): string {
  const m = (err as Error)?.message ?? String(err);
  if (/Cannot find (module|package)|ERR_MODULE_NOT_FOUND/.test(m)) {
    return (
      "the Claude Agent SDK is not installed — run `npm i @anthropic-ai/claude-agent-sdk`, " +
      "or use the CLI backend (makeBackend(\"claude-cli\"))."
    );
  }
  return m;
}

// ---- child-process helpers ----

/** Yield newline-delimited stdout lines from a child process. */
async function* readLines(child: ChildProcess): AsyncIterable<string> {
  if (!child.stdout) return;
  let buf = "";
  const chunks: string[] = [];
  let resolveNext: (() => void) | null = null;
  let ended = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      chunks.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
    resolveNext?.();
    resolveNext = null;
  });
  const end = (): void => {
    if (buf.length) chunks.push(buf), (buf = "");
    ended = true;
    resolveNext?.();
    resolveNext = null;
  };
  child.stdout.on("end", end);
  child.on("close", end);
  while (true) {
    if (chunks.length) {
      yield chunks.shift() as string;
      continue;
    }
    if (ended) return;
    await new Promise<void>((r) => (resolveNext = r));
  }
}

function onExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(-1));
  });
}
