// @vitest-environment node
//
// The Agent Gateway, tested at its two load-bearing seams:
//   1. marks → prompt formatting (formatTurn/formatMark) — the structured context a backend receives.
//   2. the SSE stream: live push of AgentEvents, `Last-Event-ID` replay/resume, and the auth gate.
// A deterministic FakeBackend stands in for a real agent so the stream shape is exercised without an SDK.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentGateway, bearerAuth, openAuth } from "../src/agent/gateway";
import { formatTurn, formatMark } from "../src/agent/format";
import type {
  AgentBackend,
  AgentEvent,
  AgentInput,
  AgentSession,
  AgentSessionOptions,
  WireItem,
} from "../src/agent/backend";

// ---- marks → prompt formatting ----
describe("formatMark / formatTurn", () => {
  it("formats an element mark with component + source + selector", () => {
    const mark: WireItem = {
      id: "1",
      kind: "element",
      text: "make this bold",
      pageUrl: "http://x/pricing",
      route: "/pricing",
      viewport: { w: 1, h: 1, dpr: 1 },
      timestamp: "t",
      element: { component: "PricingCard", source: "app/pricing.tsx:11:7", selector: "[data-testid=pro]", text: "Pro" },
    };
    const line = formatMark(mark);
    expect(line).toContain("<PricingCard>");
    expect(line).toContain("app/pricing.tsx:11:7");
    expect(line).toContain("[data-testid=pro]");
    expect(line).toContain("on route /pricing");
    expect(line).toContain('note: "make this bold"');
  });

  it("formats a text-edit mark as a change instruction anchored on source", () => {
    const line = formatMark({
      id: "2",
      kind: "text-edit",
      text: "",
      pageUrl: "http://x",
      route: "/",
      viewport: { w: 1, h: 1, dpr: 1 },
      timestamp: "t",
      element: { source: "app/hero.tsx:4:3" },
      oldText: "Hello",
      newText: "Welcome",
    });
    expect(line).toBe('change text at `app/hero.tsx:4:3` from "Hello" to "Welcome" on route /');
  });

  it("formats a region mark with the screenshot path + selection", () => {
    const line = formatMark({
      id: "3",
      kind: "region",
      text: "",
      pageUrl: "http://x",
      viewport: { w: 1, h: 1, dpr: 1 },
      timestamp: "t",
      image: { mime: "image/png", hasRedBox: true, selectionRect: { x: 10, y: 20, w: 100, h: 50 }, path: "/tmp/shot.png" },
    });
    expect(line).toContain("red box");
    expect(line).toContain("100×50 at 10,20");
    expect(line).toContain("/tmp/shot.png");
  });

  it("composes a whole turn: typed text + a context block + image paths", () => {
    const input: AgentInput = {
      text: "tighten the spacing",
      marks: [
        { id: "a", kind: "element", text: "", pageUrl: "http://x", route: "/", viewport: { w: 1, h: 1, dpr: 1 }, timestamp: "t", element: { component: "Nav" } },
        { id: "b", kind: "region", text: "", pageUrl: "http://x", viewport: { w: 1, h: 1, dpr: 1 }, timestamp: "t", image: { mime: "image/png", hasRedBox: true, selectionRect: { x: 0, y: 0, w: 4, h: 4 }, path: "/tmp/r.png" } },
      ],
    };
    const { prompt, imagePaths } = formatTurn(input);
    expect(prompt.startsWith("tighten the spacing")).toBe(true);
    expect(prompt).toContain("2 marks from the preview");
    expect(prompt).toContain("<Nav>");
    expect(imagePaths).toEqual(["/tmp/r.png"]);
  });
});

// ---- a deterministic backend for the stream tests ----
class FakeSession implements AgentSession {
  readonly id: string;
  private log: { role: "user" | "assistant"; text: string }[] = [];
  constructor(id: string) {
    this.id = id;
  }
  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    this.log.push({ role: "user", text: input.text ?? "" });
    yield { type: "turn_start" };
    yield { type: "token", text: "Hello " };
    yield { type: "token", text: input.text?.includes("blue") ? "blue!" : "world" };
    yield { type: "tool_use", name: "Edit", input: { file_path: "app/x.tsx" } };
    yield { type: "file_changed", path: "app/x.tsx" };
    yield { type: "turn_end", ok: true };
    this.log.push({ role: "assistant", text: "done" });
  }
  async interrupt(): Promise<void> {}
  history(): { role: "user" | "assistant"; text: string }[] {
    return this.log;
  }
  async close(): Promise<void> {}
}
class FakeBackend implements AgentBackend {
  readonly id = "fake";
  async startSession(opts: AgentSessionOptions): Promise<AgentSession> {
    return new FakeSession(opts.sessionId);
  }
}

interface SseEvent {
  id?: number;
  event?: string;
  data?: AgentEvent;
}

/** Read an SSE response, collecting parsed events until `until` is satisfied or the budget elapses. */
async function readSse(
  res: Response,
  until: (events: SseEvent[]) => boolean,
  budgetMs = 4000,
): Promise<SseEvent[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: SseEvent[] = [];
  const deadline = Date.now() + budgetMs;
  try {
    while (Date.now() < deadline) {
      // Race the read against the remaining budget so a stalled stream can never hang the test.
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), Math.max(0, deadline - Date.now()))),
      ]);
      if (next === "timeout") break;
      const { value, done } = next;
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev: SseEvent = {};
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) ev.id = Number(line.slice(4));
          else if (line.startsWith("event: ")) ev.event = line.slice(7);
          else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
        }
        if (ev.event) events.push(ev);
        if (until(events)) return events;
      }
    }
    return events;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

describe("AgentGateway SSE stream", () => {
  let server: Server;
  let base: string;
  let gw: AgentGateway;

  beforeAll(async () => {
    gw = new AgentGateway(new FakeBackend(), { cwd: "/tmp/app", auth: openAuth() });
    server = createServer((req, res) => {
      if (!gw.handler(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await gw.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("streams a turn's events live over SSE and folds tokens into the transcript", async () => {
    const streamRes = await fetch(`${base}/__nitpicker-harness/agent/stream?sessionId=live`);
    // Kick the turn AFTER the stream is open so we observe the live push path.
    const post = await fetch(`${base}/__nitpicker-harness/agent/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "live", text: "make it blue" }),
    });
    expect(post.status).toBe(202);

    const events = await readSse(streamRes, (evs) => evs.some((e) => e.event === "turn_end"));
    const types = events.map((e) => e.event);
    expect(types[0]).toBe("turn_start");
    expect(types).toContain("token");
    expect(types).toContain("file_changed");
    expect(types[types.length - 1]).toBe("turn_end");
    const text = events
      .filter((e) => e.event === "token")
      .map((e) => (e.data as { text: string }).text)
      .join("");
    expect(text).toBe("Hello blue!");
    // ids are strictly increasing (the resume cursor).
    const ids = events.map((e) => e.id!);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    // History is server-authoritative: user + assistant messages recorded.
    const hist = await (await fetch(`${base}/__nitpicker-harness/agent/history?sessionId=live`)).json();
    expect(hist.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(hist.running).toBe(false);
  });

  it("replays with Last-Event-ID: 0 (full turn) and from a mid cursor (resume)", async () => {
    // Run a full turn with NO stream connected — events accumulate in the log.
    await fetch(`${base}/__nitpicker-harness/agent/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "replay", text: "hi" }),
    });
    // Wait for it to finish.
    for (let i = 0; i < 50; i++) {
      const h = await (await fetch(`${base}/__nitpicker-harness/agent/history?sessionId=replay`)).json();
      if (!h.running) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Full replay from 0.
    const full = await readSse(
      await fetch(`${base}/__nitpicker-harness/agent/stream?sessionId=replay`, {
        headers: { "Last-Event-ID": "0" },
      }),
      (evs) => evs.some((e) => e.event === "turn_end"),
    );
    expect(full[0].event).toBe("turn_start");
    expect(full.some((e) => e.event === "turn_end")).toBe(true);

    // Resume from a mid cursor: only events with id > cursor come back.
    const cursor = full[2].id!; // skip the first couple of events
    const resumed = await readSse(
      await fetch(`${base}/__nitpicker-harness/agent/stream?sessionId=replay`, {
        headers: { "Last-Event-ID": String(cursor) },
      }),
      (evs) => evs.some((e) => e.event === "turn_end"),
    );
    expect(resumed.every((e) => e.id! > cursor)).toBe(true);
    expect(resumed.length).toBe(full.length - 3);
  });

  it("rejects an empty turn and an unknown route", async () => {
    const empty = await fetch(`${base}/__nitpicker-harness/agent/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "x" }),
    });
    expect(empty.status).toBe(400);
    const unknown = await fetch(`${base}/__nitpicker-harness/agent/nope`);
    expect(unknown.status).toBe(404);
  });
});

describe("AgentGateway auth", () => {
  let server: Server;
  let base: string;
  let gw: AgentGateway;
  const TOKEN = "s3cr3t-token";

  beforeAll(async () => {
    gw = new AgentGateway(new FakeBackend(), { cwd: "/tmp/app", auth: bearerAuth(TOKEN) });
    server = createServer((req, res) => {
      if (!gw.handler(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await gw.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("401s without a token, accepts a Bearer header and a cookie", async () => {
    const noAuth = await fetch(`${base}/__nitpicker-harness/agent/history?sessionId=a`);
    expect(noAuth.status).toBe(401);

    const withHeader = await fetch(`${base}/__nitpicker-harness/agent/history?sessionId=a`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(withHeader.status).toBe(200);

    const withCookie = await fetch(`${base}/__nitpicker-harness/agent/history?sessionId=a`, {
      headers: { cookie: `nh_agent_token=${TOKEN}` },
    });
    expect(withCookie.status).toBe(200);

    const wrong = await fetch(`${base}/__nitpicker-harness/agent/history?sessionId=a`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });
});
