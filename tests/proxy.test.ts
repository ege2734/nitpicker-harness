// @vitest-environment node
//
// End-to-end proxy test: stand up a fake "target dev server", front it with the real harness, and
// assert the streamed HTML gets the overlay injected, framing/CSP headers are relaxed, the overlay
// bundle is served + actually bundles the reused core, and non-HTML assets pass through untouched.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startHarness, type Harness } from "../src/proxy/server";

let target: Server;
let targetPort: number;
let harness: Harness;

beforeAll(async () => {
  target = createServer((req, res) => {
    if (req.url === "/asset.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hello: "world" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'; connect-src 'self'",
    });
    res.end("<html><head><title>t</title></head><body><h1>hello</h1></body></html>");
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  targetPort = (target.address() as AddressInfo).port;

  harness = await startHarness({
    target: `http://127.0.0.1:${targetPort}`,
    port: 0 as unknown as number, // let the OS pick; startHarness reports the bound url
    session: "demo",
    endpoint: "http://127.0.0.1:5178",
    log: () => {},
  });
  // startHarness computes url from the requested port; when 0, read the real bound port instead.
  const bound = (harness.server.address() as AddressInfo).port;
  harness.url = `http://127.0.0.1:${bound}`;
}, 30_000);

afterAll(async () => {
  await harness.close();
  await new Promise<void>((r) => target.close(() => r()));
});

describe("proxy harness (e2e)", () => {
  it("injects the overlay script into proxied HTML", async () => {
    const res = await fetch(harness.url + "/");
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("<h1>hello</h1>"); // original content preserved
    expect(body).toContain("/__nitpicker-harness/overlay.js");
    expect(body).toContain("session=demo");
    expect(body.indexOf("/__nitpicker-harness/overlay.js")).toBeLessThan(body.indexOf("</body>"));
  });

  it("strips X-Frame-Options and relaxes CSP frame-ancestors", async () => {
    const res = await fetch(harness.url + "/");
    expect(res.headers.get("x-frame-options")).toBeNull();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).not.toMatch(/frame-ancestors/i);
    expect(csp).toContain("http://127.0.0.1:5178");
  });

  it("serves the bundled overlay JS with the reused core", async () => {
    const res = await fetch(harness.url + "/__nitpicker-harness/overlay.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    // The IIFE bundle contains our mount breadcrumb and the reused nitpicker dock markup.
    expect(js).toContain("nitpicker-harness");
    expect(js).toContain("np-dock");
  }, 30_000);

  it("passes non-HTML assets through untouched", async () => {
    const res = await fetch(harness.url + "/asset.json");
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = await res.json();
    expect(json).toEqual({ hello: "world" });
  });

  it("answers its own health endpoint", async () => {
    const res = await fetch(harness.url + "/__nitpicker-harness/health");
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.service).toBe("nitpicker-harness");
  });
});
