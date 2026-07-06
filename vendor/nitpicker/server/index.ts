// nitpicker sidecar — the local, dev-only transport server.
//
// Deliberately shaped as a minimal, predictable long-poll transport:
//   POST /blob        raw binary screenshot upload → { id, path, url }   (keeps images out of JSON)
//   POST /feedback    enqueue one item or a batch { session, items:[…] }
//   GET  /poll        agent long-poll: DRAINS the queue, heartbeats ~15s, indefinite by default
//   GET  /pending     cheap, synchronous signal: { pending: <queued count> } — never drains
//   GET  /wait        agent-driver long-poll: resolves { status:"pending", pending } the instant the
//                     queue is non-empty; NEVER drains. Backs the Stop-hook waker (see src/hook.ts).
//   GET  /blob/:id    serve a stored blob (fallback to the file path the item already carries)
//   GET  /health      liveness
//   POST /shutdown    stop the process
//
// HARNESS-LOCAL DELTA: /pending and /wait are additions the harness needs to *drive an idle agent*
// (a Stop-hook parks on /wait with zero token cost and wakes the agent the instant a mark lands). They
// are non-draining by design, so the exactly-once drain guarantee still lives solely on /poll. When
// re-syncing vendor/nitpicker/, preserve these two handlers.
//
// Session identity is a caller-supplied string (project/session id), never a file path. Zero
// third-party deps: node:http only, so nothing here can ever leak into the app or prod.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SessionStore, type FeedbackItem } from "./store";
import { saveBlob, readBlob } from "./blobs";

const DEFAULT_PORT = 5178;
const BODY_LIMIT = 32 * 1024 * 1024; // 32mb — generous; images arrive via /blob anyway
const HEARTBEAT_MS = 15_000; // ~15s keepalive to hold the long-poll open

const store = new SessionStore();

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Nitpicker-Mime, X-Nitpicker-Session");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Read a request body up to BODY_LIMIT, aborting the connection if the cap is exceeded. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function baseUrl(req: IncomingMessage): string {
  return `http://${req.headers.host ?? `127.0.0.1:${DEFAULT_PORT}`}`;
}

async function handleFeedback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    return json(res, 400, { error: "invalid JSON" });
  }
  const b = body as { session?: string; items?: FeedbackItem[] } & Partial<FeedbackItem>;
  const session = b.session;
  if (!session) return json(res, 400, { error: "missing session" });
  // Accept a batch ({ session, items:[…] }) or a single bare item ({ session, id, kind, … }).
  const items: FeedbackItem[] = Array.isArray(b.items)
    ? b.items
    : b.kind
      ? [b as FeedbackItem]
      : [];
  if (items.length === 0) return json(res, 400, { error: "no items" });
  store.enqueue(session, items);
  json(res, 200, { ok: true, queued: items.length });
}

async function handleBlob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const data = await readBody(req);
  const mime = (req.headers["x-nitpicker-mime"] as string) || "image/png";
  const blob = saveBlob(data, mime);
  json(res, 200, {
    id: blob.id,
    path: blob.path,
    url: `${baseUrl(req)}/blob/${blob.id}`,
    bytes: blob.bytes,
  });
}

function handlePoll(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const session = url.searchParams.get("session");
  if (!session) return json(res, 400, { error: "missing session" });
  const timeoutMs = Number(url.searchParams.get("timeoutMs")) || 0; // 0 => indefinite

  // Fast path: if items are already queued, drain and return immediately.
  const ready = store.drain(session);
  if (ready.length > 0) return json(res, 200, { status: "feedback", items: ready });

  // Park the request. Keep it alive with heartbeat whitespace (JSON.parse ignores leading spaces,
  // which the poll client tolerates). Deliver on the next enqueue.
  cors(res);
  res.writeHead(200, { "Content-Type": "application/json" });
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(" ");
  }, HEARTBEAT_MS);

  let done = false;
  const finish = (payload: unknown): void => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (timer) clearTimeout(timer);
    if (!res.writableEnded) res.end(JSON.stringify(payload));
  };

  const unsubscribe = store.onFeedback(session, () => {
    // Drain only when we can actually deliver; if the socket already died, leave items queued.
    if (res.writableEnded || req.destroyed) return;
    const items = store.drain(session);
    if (items.length > 0) finish({ status: "feedback", items });
  });

  const timer =
    timeoutMs > 0 ? setTimeout(() => finish({ status: "timeout", items: [] }), timeoutMs) : null;

  // Client hung up (poll killed): tear down without draining — feedback stays queued.
  req.on("close", () => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (timer) clearTimeout(timer);
  });
}

/**
 * Non-draining long-poll used to *drive* an idle agent. Resolves as soon as the session has any queued
 * feedback (fast-path if already pending, otherwise parks and wakes on the next enqueue). Crucially it
 * only PEEKS the queue — draining stays exclusive to /poll, so this can never race away an item. A
 * Stop-hook blocks here at zero token cost; when it resolves it re-invokes the agent, which then drains
 * via `poll`. `timeoutMs` (0 => indefinite) lets the caller cap the wait under its own hook deadline.
 */
function handleWait(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const session = url.searchParams.get("session");
  if (!session) return json(res, 400, { error: "missing session" });
  const timeoutMs = Number(url.searchParams.get("timeoutMs")) || 0; // 0 => indefinite

  // Fast path: already pending → answer immediately.
  const pending = store.size(session);
  if (pending > 0) return json(res, 200, { status: "pending", pending });

  // Park. Same heartbeat shape as /poll so the client's JSON.parse ignores keepalive whitespace.
  cors(res);
  res.writeHead(200, { "Content-Type": "application/json" });
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(" ");
  }, HEARTBEAT_MS);

  let done = false;
  const finish = (payload: unknown): void => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (timer) clearTimeout(timer);
    if (!res.writableEnded) res.end(JSON.stringify(payload));
  };

  const unsubscribe = store.onFeedback(session, () => {
    if (res.writableEnded || req.destroyed) return;
    const n = store.size(session);
    if (n > 0) finish({ status: "pending", pending: n }); // peek only — never drains
  });

  const timer =
    timeoutMs > 0 ? setTimeout(() => finish({ status: "timeout", pending: 0 }), timeoutMs) : null;

  req.on("close", () => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (timer) clearTimeout(timer);
  });
}

function handleBlobGet(res: ServerResponse, id: string): void {
  const blob = readBlob(id);
  if (!blob) return json(res, 404, { error: "not found" });
  cors(res);
  res.writeHead(200, { "Content-Type": blob.mime });
  res.end(blob.data);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", baseUrl(req));
  const { method } = req;

  if (method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  void (async () => {
    try {
      if (method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, service: "nitpicker-sidecar" });
      }
      if (method === "POST" && url.pathname === "/blob") return await handleBlob(req, res);
      if (method === "POST" && url.pathname === "/feedback") return await handleFeedback(req, res);
      if (method === "GET" && url.pathname === "/poll") return handlePoll(req, res, url);
      if (method === "GET" && url.pathname === "/pending") {
        const session = url.searchParams.get("session");
        if (!session) return json(res, 400, { error: "missing session" });
        return json(res, 200, { pending: store.size(session) });
      }
      if (method === "GET" && url.pathname === "/wait") return handleWait(req, res, url);
      if (method === "GET" && url.pathname.startsWith("/blob/")) {
        return handleBlobGet(res, decodeURIComponent(url.pathname.slice("/blob/".length)));
      }
      if (method === "POST" && url.pathname === "/shutdown") {
        json(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 50);
        return;
      }
      return json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  })();
});

const port = Number(process.env.NITPICKER_PORT) || DEFAULT_PORT;
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`nitpicker sidecar listening on http://127.0.0.1:${port}\n`);
});
