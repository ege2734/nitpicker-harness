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

  it("still serves the classic shell + overlay (byte-for-byte additive)", async () => {
    const shell = await fetch(harness.url + "/__nitpicker-harness/shell");
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('id="nh-send-btn"');
    const overlay = await fetch(harness.url + "/__nitpicker-harness/overlay.js");
    expect(overlay.status).toBe(200);
  }, 30_000);
});
