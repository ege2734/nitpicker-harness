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
//   • Loop-safe via the sidecar's DRAIN GENERATION, not `stop_hook_active`. The store bumps a per-session
//     `drains` counter only on a real delivery (drain returns >0 items). We remember the generation we
//     last drove at; on the next stop we re-drive iff a drain has happened since (drains advanced past
//     what we recorded) OR the batch is brand-new. If the queue is still non-empty but `drains` has NOT
//     moved, the agent ignored the earlier drive — we let it idle rather than spin. This distinguishes
//     "agent drained batch 1, batch 2 arrived mid-turn" (drains advanced → re-drive) from "agent never
//     drained" (drains unchanged → suppress), which a bare `pending > 0` guard cannot.
import { get } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface StopHookInput {
  session: string;
  endpoint: string;
  /** Cap on the /wait park, in ms. 0 => indefinite; the Claude-Code hook `timeout` is the real bound. */
  timeoutMs: number;
}

export interface HookDecision {
  block: boolean;
  reason?: string;
}

/** A session's queued count plus its drain generation (see module header). */
export interface SessionInfo {
  pending: number;
  drains: number;
}

/** Injectable transport so the decision logic is testable without a live sidecar. */
export interface HookTransport {
  /** Current queued count + drain generation, or `null` if the sidecar is unreachable (fail open). */
  info(session: string): Promise<SessionInfo | null>;
  /** Park until the session has pending feedback; resolves the count + generation (0/0 on timeout/error). */
  wait(session: string, timeoutMs: number): Promise<SessionInfo>;
}

/**
 * Injectable persistence for the last drain generation we drove at, per (endpoint, session). Survives
 * across hook invocations (each Stop hook is a fresh process), so the loop guard can compare against the
 * generation from the *previous* turn.
 */
export interface HookState {
  /** The drain generation we last drove this session at, or `null` if we never have. */
  lastDriven(session: string): number | null;
  /** Record that we just drove this session at drain generation `drains`. */
  recordDrive(session: string, drains: number): void;
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
  state: HookState,
): Promise<HookDecision> {
  const info = await transport.info(input.session);
  if (info === null) return { block: false }; // sidecar down → fail open, never wedge the stop

  if (info.pending > 0) {
    const last = state.lastDriven(input.session);
    // We drove before AND no drain has happened since (same generation) → the agent ignored the drive.
    // Suppress on strict equality only; a differing (incl. lower, post-restart) generation → drive.
    if (last !== null && info.drains === last) return { block: false };
    state.recordDrive(input.session, info.drains);
    return { block: true, reason: buildReason(info.pending, input.session) };
  }

  // Idle: queue empty at entry, so nothing here can have been "ignored" — anything that lands during the
  // park is genuinely new. Park on /wait (zero token cost) and drive if a mark arrives before the deadline.
  const w = await transport.wait(input.session, input.timeoutMs);
  if (w.pending > 0) {
    state.recordDrive(input.session, w.drains);
    return { block: true, reason: buildReason(w.pending, input.session) };
  }
  return { block: false };
}

/** Real HTTP transport against a running sidecar. Both calls resolve softly on error — never throw. */
export function httpTransport(endpoint: string): HookTransport {
  return {
    info(session) {
      const u = new URL("/pending", endpoint);
      u.searchParams.set("session", session);
      return new Promise((resolve) => {
        const req = get(u, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              const p = JSON.parse(body) as { pending?: number; drains?: number };
              resolve({ pending: Number(p.pending) || 0, drains: Number(p.drains) || 0 });
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
            if (!trimmed) return resolve({ pending: 0, drains: 0 });
            try {
              const p = JSON.parse(trimmed) as { pending?: number; drains?: number };
              resolve({ pending: Number(p.pending) || 0, drains: Number(p.drains) || 0 });
            } catch {
              resolve({ pending: 0, drains: 0 });
            }
          });
        });
        req.on("error", () => resolve({ pending: 0, drains: 0 })); // never block the stop on a transport error
      });
    },
  };
}

/** Filesystem-safe key for the state file — endpoint + session, non-word chars collapsed. */
function stateKey(endpoint: string, session: string): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `nitpicker-harness-drive-${safe(endpoint)}-${safe(session)}.json`;
}

/**
 * Default file-backed HookState under os.tmpdir(). Each Stop hook is a fresh process, so the last-driven
 * generation must persist on disk between invocations. Tolerates a missing/corrupt file as `null`.
 */
export function fileHookState(endpoint: string, stateDir: string = tmpdir()): HookState {
  const path = (session: string): string => join(stateDir, stateKey(endpoint, session));
  return {
    lastDriven(session) {
      try {
        const parsed = JSON.parse(readFileSync(path(session), "utf8")) as { lastDriven?: number };
        return typeof parsed.lastDriven === "number" ? parsed.lastDriven : null;
      } catch {
        return null; // missing or corrupt → treat as never driven
      }
    },
    recordDrive(session, drains) {
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(path(session), JSON.stringify({ lastDriven: drains }));
      } catch {
        /* best-effort: a write failure just means we may re-drive once more than needed */
      }
    },
  };
}

/** In-memory HookState for tests (and any caller that doesn't want disk persistence). */
export function memoryHookState(): HookState {
  const seen = new Map<string, number>();
  return {
    lastDriven: (session) => (seen.has(session) ? (seen.get(session) as number) : null),
    recordDrive: (session, drains) => {
      seen.set(session, drains);
    },
  };
}

/** Drain stdin so a piped Stop-hook event doesn't EPIPE; the decision no longer reads its fields. */
export function drainStdin(): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolve(); // nothing piped (e.g. a manual --session invocation)
    stdin.on("data", () => {});
    stdin.on("end", () => resolve());
    stdin.on("error", () => resolve());
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
  await drainStdin(); // consume the piped event (loop-safety comes from the drain generation, not it)
  const decision = await decideStopHook(
    { session: args.session, endpoint: args.endpoint, timeoutMs: args.timeoutMs },
    httpTransport(args.endpoint),
    fileHookState(args.endpoint),
  );
  if (decision.block) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }));
  }
}
