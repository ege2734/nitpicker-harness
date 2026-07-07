// @vitest-environment node
//
// Embedded mode wired through the REAL proxy harness: the `mountExtra`/`builderPane` hooks serve the Agent
// Gateway routes + the builder pane on the existing server/origin, and the classic paths stay intact. Also
// proves the builder browser bundle actually builds (esbuild) and carries the gateway client.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startHarness, type Harness } from "../src/proxy/server";
import { AgentGateway } from "../src/agent/gateway";
import type { AgentBackend, AgentSession, AgentSessionOptions } from "../src/agent/backend";

class NoopBackend implements AgentBackend {
  readonly id = "noop";
  startSession(_opts: AgentSessionOptions): Promise<AgentSession> {
    throw new Error("not used by these tests");
  }
}

let target: Server;
let harness: Harness;
let gw: AgentGateway;

beforeAll(async () => {
  target = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><head></head><body><h1>app</h1></body></html>");
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const targetPort = (target.address() as AddressInfo).port;

  gw = new AgentGateway(new NoopBackend(), { cwd: "/tmp/app" });
  harness = await startHarness({
    target: `http://127.0.0.1:${targetPort}`,
    port: 0 as unknown as number,
    session: "embed",
    endpoint: "http://127.0.0.1:5178",
    log: () => {},
    mountExtra: gw.handler,
    builderPane: true,
  });
  harness.url = `http://127.0.0.1:${(harness.server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await gw.close();
  await harness.close();
  await new Promise<void>((r) => target.close(() => r()));
});

describe("embedded mode through the proxy", () => {
  it("serves the builder pane with a live-transcript rail + the build bundle", async () => {
    const res = await fetch(harness.url + "/__nitpicker-harness/build");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The iframe loads the app with a PLAIN src — suppression is mode-gated in the proxy (builderPane on ⇒
    // the classic in-frame overlay is never injected), so no query flag is needed on the src. See the
    // suppression tests below (including the redirect case).
    expect(html).toContain('<iframe id="nh-frame" src="/"');
    expect(html).toContain('id="nh-transcript"');
    expect(html).toContain("/__nitpicker-harness/build.js");
    expect(html).toContain("session=embed");
    // The mode toolbar is shared with the shell.
    expect(html).toContain('id="nh-mode-region"');
  });

  it("builds the builder bundle carrying the gateway client", async () => {
    const res = await fetch(harness.url + "/__nitpicker-harness/build.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js).toContain("builder pane mounted");
    // Minification concatenates the AGENT_PREFIX const with the route, so assert on the (stable) prefix.
    expect(js).toContain("/__nitpicker-harness/agent");
    expect(js).toContain("EventSource");
  }, 30_000);

  it("mounts the Agent Gateway routes on the same origin", async () => {
    const res = await fetch(harness.url + "/__nitpicker-harness/agent/history?sessionId=embed");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe("embed");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.running).toBe(false);
  });

  it("does NOT inject the classic overlay into ANY app page (mode-gated, no double UI)", async () => {
    // Embedded harness (builderPane on) ⇒ every app request is suppressed, with NO query flag. A PLAIN `/`
    // request must come back overlay-free (the builder pane is the sole interface).
    const res = await fetch(harness.url + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>app</h1>");
    expect(html).not.toContain('data-nitpicker-harness="overlay"');
    expect(html).not.toContain("/__nitpicker-harness/overlay.js");
  });

  it("still serves the classic shell + overlay (byte-for-byte additive)", async () => {
    const shell = await fetch(harness.url + "/__nitpicker-harness/shell");
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('id="nh-send-btn"');
    const overlay = await fetch(harness.url + "/__nitpicker-harness/overlay.js");
    expect(overlay.status).toBe(200);
  }, 30_000);
});

// The crux of this fix: the previous (query-param) suppression rode only the iframe's initial `src`, so a
// target that 307-redirects `/`→`/dashboard` (e.g. the Loom shell) dropped the flag and the LANDED page got
// the classic overlay re-injected — the exact "double UI" bug. Mode-gating (builderPane on ⇒ never inject)
// makes the LANDED page overlay-free too, because suppression no longer depends on the request URL at all.
describe("embedded mode keeps redirect + SPA-navigation targets overlay-free", () => {
  let rtarget: Server;
  let rharness: Harness;
  let rgw: AgentGateway;

  beforeAll(async () => {
    rtarget = createServer((req, res) => {
      if ((req.url ?? "/").startsWith("/dashboard")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><head></head><body><h1>dashboard</h1></body></html>");
        return;
      }
      // `/` (with any query string) 307-redirects to /dashboard, dropping the query — like the Loom shell.
      res.writeHead(307, { location: "/dashboard" });
      res.end();
    });
    await new Promise<void>((r) => rtarget.listen(0, "127.0.0.1", r));
    const port = (rtarget.address() as AddressInfo).port;
    rgw = new AgentGateway(new NoopBackend(), { cwd: "/tmp/app" });
    rharness = await startHarness({
      target: `http://127.0.0.1:${port}`,
      port: 0 as unknown as number,
      session: "embed",
      endpoint: "http://127.0.0.1:5178",
      log: () => {},
      mountExtra: rgw.handler,
      builderPane: true,
    });
    rharness.url = `http://127.0.0.1:${(rharness.server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await rgw.close();
    await rharness.close();
    await new Promise<void>((r) => rtarget.close(() => r()));
  });

  it("the page LANDED on after a `/`→`/dashboard` redirect has NO overlay", async () => {
    // `fetch` follows the 307 automatically; the resolved response is the /dashboard page.
    const res = await fetch(rharness.url + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>dashboard</h1>");
    expect(html).not.toContain('data-nitpicker-harness="overlay"');
    expect(html).not.toContain("/__nitpicker-harness/overlay.js");
  });

  it("a direct request to the redirect target (SPA/hard-nav) also has NO overlay", async () => {
    const res = await fetch(rharness.url + "/dashboard");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>dashboard</h1>");
    expect(html).not.toContain('data-nitpicker-harness="overlay"');
  });
});

// Classic feedback-proxy mode (builderPane OFF — pocketwatcher, membership-management) must be byte-for-byte
// unchanged: the overlay is STILL injected on every app page, including a redirect target.
describe("classic feedback-proxy mode still injects the overlay (no regression)", () => {
  let ctarget: Server;
  let charness: Harness;

  beforeAll(async () => {
    ctarget = createServer((req, res) => {
      if ((req.url ?? "/").startsWith("/dashboard")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><head></head><body><h1>dashboard</h1></body></html>");
        return;
      }
      res.writeHead(307, { location: "/dashboard" });
      res.end();
    });
    await new Promise<void>((r) => ctarget.listen(0, "127.0.0.1", r));
    const port = (ctarget.address() as AddressInfo).port;
    // No builderPane / mountExtra → the classic feedback-proxy harness.
    charness = await startHarness({
      target: `http://127.0.0.1:${port}`,
      port: 0 as unknown as number,
      session: "classic",
      endpoint: "http://127.0.0.1:5178",
      log: () => {},
    });
    charness.url = `http://127.0.0.1:${(charness.server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await charness.close();
    await new Promise<void>((r) => ctarget.close(() => r()));
  });

  it("injects the overlay on a plain page", async () => {
    const res = await fetch(charness.url + "/dashboard");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>dashboard</h1>");
    expect(html).toContain('data-nitpicker-harness="overlay"');
    expect(html).toContain("/__nitpicker-harness/overlay.js");
  });

  it("injects the overlay on the page landed on after a redirect", async () => {
    const res = await fetch(charness.url + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>dashboard</h1>");
    expect(html).toContain('data-nitpicker-harness="overlay"');
  });
});
