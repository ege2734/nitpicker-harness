// nitpicker-harness — the Agent Gateway (hz-agent §3.2). Mounts on the EXISTING harness http server (via
// `startHarness`'s `mountExtra` hook), so the embedded agent channel is same-origin with the builder pane:
// no extra port, no CSP dance, no HTTP-upgrade handshake (unlike the HMR socket).
//
//   POST /__nitpicker-harness/agent/message    one user turn: { sessionId, text, marks:[WireItem…] }
//   GET  /__nitpicker-harness/agent/stream      SSE server-push of AgentEvents; `Last-Event-ID` resumes
//   POST /__nitpicker-harness/agent/interrupt   cancel the in-flight turn
//   GET  /__nitpicker-harness/agent/history     full transcript for pane rehydration
//
// The transcript + the per-session event log are SERVER-SIDE AUTHORITATIVE (keyed by sessionId): the pane
// is a view. On (re)load it GETs /history then opens /stream with the last id it saw to resume a turn that
// is still running — stronger than the builder-shell's parent-heap-only state (survives a parent reload).
//
// Marks → prompt formatting lives here (src/agent/format.ts) so backends stay dumb. Region images already
// flow through the sidecar `/blob` store to a local `path`; the embedded agent opens that path directly, so
// there is zero new image plumbing.
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatTurn } from "./format";
import type {
  AgentBackend,
  AgentEvent,
  AgentInput,
  AgentMessage,
  AgentSession,
  AgentSessionOptions,
  WireItem,
} from "./backend";

export const AGENT_PREFIX = "/__nitpicker-harness/agent";

/** Gateway auth. `authorize` returns true for an authorized request. The token rides an `Authorization:
 *  Bearer` header or a cookie — NEVER the query string (it would leak in logs; hz-agent §5). */
export interface GatewayAuth {
  authorize(req: IncomingMessage): boolean;
}

/** Local default: loopback-open (fine for the single-machine CLI). Loom injects a real token gate. */
export function openAuth(): GatewayAuth {
  return { authorize: () => true };
}

/** Bearer/cookie token gate for any non-loopback deploy (hz-agent §5, loom-decision D9). */
export function bearerAuth(token: string, cookieName = "nh_agent_token"): GatewayAuth {
  return {
    authorize(req) {
      const auth = req.headers.authorization;
      if (auth && auth.startsWith("Bearer ") && safeEqual(auth.slice(7).trim(), token)) return true;
      const cookie = readCookie(req.headers.cookie, cookieName);
      return cookie !== null && safeEqual(cookie, token);
    },
  };
}

export interface AgentGatewayOptions {
  /** The app repo path each session is rooted at (the agent edits here). */
  cwd: string;
  /** Auth gate; defaults to loopback-open. */
  auth?: GatewayAuth;
  /** Harness-supplied system framing for every session. */
  systemContext?: string;
  model?: string;
  log?: (m: string) => void;
  /** Max events retained per session for `Last-Event-ID` resume (a turn's worth; default 1000). */
  historyLimit?: number;
}

interface SessionState {
  id: string;
  session: AgentSession | null;
  starting: Promise<AgentSession> | null;
  transcript: AgentMessage[];
  /** Monotonic event log for SSE replay/resume. */
  events: { id: number; event: AgentEvent }[];
  seq: number;
  /** The event id just before the in-flight turn's first event — the cursor a fresh pane resumes from so it
   *  replays the WHOLE running turn (its tokens aren't in the transcript until turn_end). */
  turnStartSeq: number;
  clients: Set<ServerResponse>;
  running: boolean;
}

const SSE_KEEPALIVE_MS = 15_000;

export class AgentGateway {
  private readonly sessions = new Map<string, SessionState>();
  private readonly auth: GatewayAuth;
  private readonly log: (m: string) => void;
  private readonly historyLimit: number;

  constructor(
    private readonly backend: AgentBackend,
    private readonly opts: AgentGatewayOptions,
  ) {
    this.auth = opts.auth ?? openAuth();
    this.log = opts.log ?? (() => {});
    this.historyLimit = opts.historyLimit ?? 1000;
  }

  /** The `mountExtra` handler: returns true iff it owned the request. Wired into `startHarness` before
   *  `proxy.web`. Any `/agent/*` route is handled here (authorized routes only; others → 401). */
  readonly handler = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(AGENT_PREFIX)) return false;
    const route = url.pathname.slice(AGENT_PREFIX.length);

    if (!this.auth.authorize(req)) {
      this.send(res, 401, { error: "unauthorized" });
      return true;
    }

    if (req.method === "POST" && route === "/message") {
      void this.handleMessage(req, res);
      return true;
    }
    if (req.method === "GET" && route === "/stream") {
      this.handleStream(req, res, url);
      return true;
    }
    if (req.method === "POST" && route === "/interrupt") {
      void this.handleInterrupt(req, res);
      return true;
    }
    if (req.method === "GET" && route === "/history") {
      this.handleHistory(res, url);
      return true;
    }
    this.send(res, 404, { error: "not found" });
    return true;
  };

  /** Seed a pre-started session for `sessionId` (the composition root starts the primary session eagerly so
   *  it can expose the `AgentSession` handle). Subsequent turns for that id reuse this session. */
  primeSession(sessionId: string, session: AgentSession): void {
    this.stateFor(sessionId).session = session;
  }

  /** Tear down every live session (dev-server/agent idle-reclaim path). */
  async close(): Promise<void> {
    for (const s of this.sessions.values()) {
      for (const c of s.clients) if (!c.writableEnded) c.end();
      try {
        await s.session?.close();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
  }

  // ---- routes ----

  private async handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { sessionId?: string; text?: string; marks?: WireItem[] };
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return this.send(res, 400, { error: "invalid JSON" });
    }
    const sessionId = body.sessionId;
    if (!sessionId) return this.send(res, 400, { error: "missing sessionId" });
    const input: AgentInput = { text: body.text, marks: body.marks };
    if (!input.text && !(input.marks && input.marks.length)) {
      return this.send(res, 400, { error: "empty turn (no text or marks)" });
    }

    const state = this.stateFor(sessionId);
    if (state.running) return this.send(res, 409, { error: "a turn is already in flight" });

    // Accept immediately; the turn streams over SSE. Kick off the turn without blocking the response.
    this.send(res, 202, { ok: true, sessionId });
    void this.runTurn(state, input);
  }

  private handleStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const sessionId = url.searchParams.get("sessionId") ?? "default";
    const state = this.stateFor(sessionId);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // Flush headers NOW (even with nothing to replay) so the client's stream opens immediately — otherwise
    // an idle session would buffer headers until the first event and the pane's `await fetch()` would hang.
    res.write(": connected\n\n");
    // Resume: replay everything after the last id the client saw (header first, `?lastEventId=` fallback
    // for EventSource polyfills that cannot set the header). NEVER the token — this is just a cursor.
    const lastId = Number(
      req.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? 0,
    );
    for (const e of state.events) {
      if (e.id > lastId) writeSse(res, e.id, e.event);
    }
    state.clients.add(res);
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, SSE_KEEPALIVE_MS);
    const done = (): void => {
      clearInterval(keepalive);
      state.clients.delete(res);
    };
    req.on("close", done);
    res.on("close", done);
  }

  private async handleInterrupt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let sessionId = "default";
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.sessionId) sessionId = body.sessionId;
    } catch {
      /* allow interrupt with no body → default session */
    }
    const state = this.sessions.get(sessionId);
    try {
      await state?.session?.interrupt();
    } catch {
      /* best-effort */
    }
    this.send(res, 200, { ok: true });
  }

  private handleHistory(res: ServerResponse, url: URL): void {
    const sessionId = url.searchParams.get("sessionId") ?? "default";
    const state = this.sessions.get(sessionId);
    // `resumeFrom` is the cursor the pane opens its SSE stream at: the current end when idle (replay
    // nothing), or the in-flight turn's start when running (replay the whole live turn, whose tokens are
    // not yet in `messages`). Prevents both duplication and mid-turn token loss on (re)load.
    const running = state?.running ?? false;
    this.send(res, 200, {
      sessionId,
      messages: state?.transcript ?? [],
      running,
      lastEventId: state?.seq ?? 0,
      resumeFrom: running ? (state?.turnStartSeq ?? 0) : (state?.seq ?? 0),
    });
  }

  // ---- turn engine ----

  private async runTurn(state: SessionState, input: AgentInput): Promise<void> {
    state.running = true;
    state.turnStartSeq = state.seq; // cursor a resuming pane rewinds to for the whole live turn
    // Server-authoritative transcript: record the user turn (with the composed prompt visible for debugging
    // via the note text) up front so a pane that connects mid-turn rehydrates it via /history.
    state.transcript.push({ role: "user", text: input.text ?? "", marks: input.marks });
    let assistant = "";
    try {
      const session = await this.ensureSession(state);
      for await (const event of session.send(this.composeInput(input))) {
        if (event.type === "token") assistant += event.text;
        this.emit(state, event);
      }
    } catch (err) {
      this.emit(state, { type: "error", message: (err as Error).message });
      this.emit(state, { type: "turn_end", ok: false });
    } finally {
      state.transcript.push({ role: "assistant", text: assistant });
      state.running = false;
    }
  }

  /** The gateway owns marks→prompt formatting (backends stay dumb): fold the marks into `text` and keep the
   *  raw marks so an SDK backend can still attach region images by their local path. */
  private composeInput(input: AgentInput): AgentInput {
    const { prompt } = formatTurn(input);
    return { text: prompt, marks: input.marks };
  }

  private emit(state: SessionState, event: AgentEvent): void {
    const id = ++state.seq;
    state.events.push({ id, event });
    if (state.events.length > this.historyLimit) {
      state.events.splice(0, state.events.length - this.historyLimit);
    }
    for (const res of state.clients) {
      if (!res.writableEnded) writeSse(res, id, event);
    }
  }

  private stateFor(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        id: sessionId,
        session: null,
        starting: null,
        transcript: [],
        events: [],
        seq: 0,
        turnStartSeq: 0,
        clients: new Set(),
        running: false,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private ensureSession(state: SessionState): Promise<AgentSession> {
    if (state.session) return Promise.resolve(state.session);
    if (state.starting) return state.starting;
    const opts: AgentSessionOptions = {
      cwd: this.opts.cwd,
      sessionId: state.id,
      systemContext: this.opts.systemContext,
      model: this.opts.model,
    };
    state.starting = this.backend
      .startSession(opts)
      .then((s) => {
        state.session = s;
        state.starting = null;
        return s;
      })
      .catch((err) => {
        state.starting = null;
        throw err;
      });
    return state.starting;
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
}

// ---- helpers ----

function writeSse(res: ServerResponse, id: number, event: AgentEvent): void {
  res.write(`id: ${id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Length-stable string compare — avoids leaking token length via early-exit timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
