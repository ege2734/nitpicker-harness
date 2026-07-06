// nitpicker-harness Stop-hook — the piece that makes feedback DRIVE an idle agent.
//
// The problem: `poll`/`poll --watch` only delivers while the agent is actively running it. The instant a
// turn ends and the agent goes idle, newly-queued marks sit in the sidecar and nothing re-invokes the
// agent. Firstmate solves the analogous problem for its crew with a blocking watcher plus a turn-end
// hook that re-invokes the agent on an OS-level event (zero tokens while idle). This is that pattern,
// adapted to a Claude-Code-style Stop hook:
//
//   • The blocking watcher is a long-poll on the sidecar's non-draining `GET /wait`. It costs zero
//     tokens and resolves the instant a mark lands.
//   • The turn-end trigger is the Stop hook itself. When the agent finishes a turn it runs this; we park
//     on /wait, and when feedback arrives we emit `{"decision":"block","reason":…}` — which re-invokes
//     the agent and tells it to drain via `poll`. Draining stays exclusively on /poll, so nothing here
//     can lose or double-deliver a mark; /wait only ever PEEKS.
//
// Reliability rules baked in:
//   • Fail OPEN: if the sidecar is unreachable we never block the agent's stop (a down sidecar must not
//     wedge the session).
//   • Loop-safe: honour `stop_hook_active`. If we already forced a continuation and the queue is STILL
//     non-empty, the agent hasn't drained yet — we let it stop rather than spin. The queue is durable,
//     so the feedback is not lost; the next turn re-arms and re-checks.
import { get } from "node:http";

export interface StopHookInput {
  session: string;
  endpoint: string;
  /** Cap on the /wait park, in ms. 0 => indefinite; the Claude-Code hook `timeout` is the real bound. */
  timeoutMs: number;
  /** True when this stop was itself produced by a prior Stop-hook continuation. */
  stopHookActive: boolean;
}

export interface HookDecision {
  block: boolean;
  reason?: string;
}

/** Injectable transport so the decision logic is testable without a live sidecar. */
export interface HookTransport {
  /** Current queued count for a session, or `null` if the sidecar is unreachable. */
  pending(session: string): Promise<number | null>;
  /** Park until the session has pending feedback; resolves with the count (0 on timeout/error). */
  wait(session: string, timeoutMs: number): Promise<number>;
}

/** The instruction handed back to the agent when feedback is waiting. */
export function buildReason(count: number, session: string): string {
  const n = `${count} nitpicker feedback item(s)`;
  return (
    `${n} ${count === 1 ? "is" : "are"} waiting from the harness overlay. ` +
    `Run \`nitpicker-harness poll --session ${session}\` now to drain the batch, then address every item ` +
    `(open each region PNG at its local path; for elements grep by component/selector/text + route) ` +
    `before you stop. Do not stop with feedback still queued.`
  );
}

/**
 * Pure decision core. Returns whether to block the stop (re-invoking the agent) and with what reason.
 * See the module header for the reliability rules; this is where they live.
 */
export async function decideStopHook(
  input: StopHookInput,
  transport: HookTransport,
): Promise<HookDecision> {
  const pending = await transport.pending(input.session);
  if (pending === null) return { block: false }; // sidecar down → fail open, never wedge the stop
  if (input.stopHookActive && pending > 0) {
    // We already forced a continuation and the agent still hasn't drained. Blocking again would spin;
    // the queue is durable, so let it stop — the next turn (or an explicit poll) picks the batch up.
    return { block: false };
  }
  const n = await transport.wait(input.session, input.timeoutMs);
  if (n > 0) return { block: true, reason: buildReason(n, input.session) };
  return { block: false };
}

/** Real HTTP transport against a running sidecar. Both calls resolve softly on error — never throw. */
export function httpTransport(endpoint: string): HookTransport {
  return {
    pending(session) {
      const u = new URL("/pending", endpoint);
      u.searchParams.set("session", session);
      return new Promise((resolve) => {
        const req = get(u, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              resolve(Number((JSON.parse(body) as { pending?: number }).pending) || 0);
            } catch {
              resolve(null); // unparseable → treat as unreachable (fail open)
            }
          });
        });
        req.on("error", () => resolve(null)); // connection refused etc. → sidecar down
      });
    },
    wait(session, timeoutMs) {
      const u = new URL("/wait", endpoint);
      u.searchParams.set("session", session);
      if (timeoutMs > 0) u.searchParams.set("timeoutMs", String(timeoutMs));
      return new Promise((resolve) => {
        const req = get(u, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c)); // heartbeats are leading whitespace; JSON.parse skips them
          res.on("end", () => {
            const trimmed = body.trim();
            if (!trimmed) return resolve(0);
            try {
              resolve(Number((JSON.parse(trimmed) as { pending?: number }).pending) || 0);
            } catch {
              resolve(0);
            }
          });
        });
        req.on("error", () => resolve(0)); // never block the stop on a transport error
      });
    },
  };
}

/** Read the Stop-hook stdin JSON (best-effort). Returns `{}` on empty/invalid input. */
export function readStopHookStdin(): Promise<{ stop_hook_active?: boolean; session_id?: string }> {
  return new Promise((resolve) => {
    let body = "";
    const stdin = process.stdin;
    // Nothing piped in (e.g. a manual `--session` invocation): don't hang.
    if (stdin.isTTY) return resolve({});
    stdin.setEncoding("utf8");
    stdin.on("data", (c) => (body += c));
    stdin.on("end", () => {
      const trimmed = body.trim();
      if (!trimmed) return resolve({});
      try {
        resolve(JSON.parse(trimmed));
      } catch {
        resolve({});
      }
    });
    stdin.on("error", () => resolve({}));
  });
}

/**
 * CLI entry: read the Stop-hook event, decide, and emit the block decision (if any) on stdout. Always
 * exits 0 — the JSON decision, not the exit code, is what drives the agent, and a soft failure must
 * leave the agent free to idle.
 */
export async function runStopHook(args: {
  session: string;
  endpoint: string;
  timeoutMs: number;
}): Promise<void> {
  const stdin = await readStopHookStdin();
  const decision = await decideStopHook(
    {
      session: args.session,
      endpoint: args.endpoint,
      timeoutMs: args.timeoutMs,
      stopHookActive: stdin.stop_hook_active === true,
    },
    httpTransport(args.endpoint),
  );
  if (decision.block) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }));
  }
}
