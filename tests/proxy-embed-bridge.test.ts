// @vitest-environment node
//
// Embed-bridge mode wired through the REAL proxy harness: when configured with a trusted-host allow-list,
// the chromeless embed page + its bundle are served, the classic in-frame overlay is suppressed (the app is
// driven from the parent host), and the bundle actually builds (esbuild) carrying the bridge. Without the
// allow-list the embed route is NOT exposed (fail-closed) and the classic overlay is injected as before.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startHarness, type Harness } from "../src/proxy/server";

const HOST = "https://loom.example";

function appTarget(): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><head></head><body><h1>app</h1></body></html>");
  });
}

async function listen(s: Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}

describe("embed-bridge mode through the proxy (configured)", () => {
  let target: Server;
  let harness: Harness;

  beforeAll(async () => {
    target = appTarget();
    const port = await listen(target);
    harness = await startHarness({
      target: `http://127.0.0.1:${port}`,
      port: 0 as unknown as number,
      session: "embed",
      endpoint: "http://127.0.0.1:5178",
      log: () => {},
      embedAllowedOrigins: [HOST],
    });
    harness.url = `http://127.0.0.1:${(harness.server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await harness.close();
    await new Promise<void>((r) => target.close(() => r()));
  });

  it("serves the chromeless embed page with the app iframe + the bundle carrying the trusted origins", async () => {
    const res = await fetch(harness.url + "/__nitpicker-harness/embed");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<iframe id="nh-frame" src="/"');
    expect(html).toContain('data-nitpicker-harness="embed"');
    expect(html).toContain("/__nitpicker-harness/embed.js");
    // The trusted host origins are baked into the bundle URL server-side (URL-encoded).
    expect(html).toContain(encodeURIComponent(HOST));
    // Chromeless: no chat rail / mode toolbar (the host renders its own).
    expect(html).not.toContain('id="nh-transcript"');
    expect(html).not.toContain('id="nh-mode-region"');
  });

  it("builds the embed bundle carrying the postMessage bridge", async () => {
    const res = await fetch(harness.url + "/__nitpicker-harness/embed.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js).toContain("embed bridge mounted");
    // The wire protocol source tags survive minification (they're string literals).
    expect(js).toContain("nitpicker-embed");
    expect(js).toContain("addEventListener");
  }, 30_000);

  it("suppresses the classic in-frame overlay on the app (driven from the parent — no double UI)", async () => {
    const res = await fetch(harness.url + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>app</h1>");
    expect(html).not.toContain('data-nitpicker-harness="overlay"');
    expect(html).not.toContain("/__nitpicker-harness/overlay.js");
  });
});

describe("embed-bridge mode is fail-closed when unconfigured", () => {
  let target: Server;
  let harness: Harness;

  beforeAll(async () => {
    target = appTarget();
    const port = await listen(target);
    // No embedAllowedOrigins → the classic feedback-proxy harness, byte-for-byte unchanged.
    harness = await startHarness({
      target: `http://127.0.0.1:${port}`,
      port: 0 as unknown as number,
      session: "classic",
      endpoint: "http://127.0.0.1:5178",
      log: () => {},
    });
    harness.url = `http://127.0.0.1:${(harness.server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await harness.close();
    await new Promise<void>((r) => target.close(() => r()));
  });

  it("does NOT serve the embed page (the request falls through to the proxied app)", async () => {
    const res = await fetch(harness.url + "/__nitpicker-harness/embed");
    // Proxied to the target, which serves its app page — NOT the embed page.
    const html = await res.text();
    expect(html).not.toContain('data-nitpicker-harness="embed"');
  });

  it("still injects the classic overlay on the app (no regression)", async () => {
    const res = await fetch(harness.url + "/");
    const html = await res.text();
    expect(html).toContain('data-nitpicker-harness="overlay"');
  });
});

// A wildcard-only allow-list must be treated as UNCONFIGURED (never trust "*"): no embed route, overlay on.
describe("embed-bridge mode ignores a wildcard-only allow-list", () => {
  let target: Server;
  let harness: Harness;

  beforeAll(async () => {
    target = appTarget();
    const port = await listen(target);
    harness = await startHarness({
      target: `http://127.0.0.1:${port}`,
      port: 0 as unknown as number,
      session: "wild",
      endpoint: "http://127.0.0.1:5178",
      log: () => {},
      embedAllowedOrigins: ["*"],
    });
    harness.url = `http://127.0.0.1:${(harness.server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await harness.close();
    await new Promise<void>((r) => target.close(() => r()));
  });

  it("treats '*' as no trusted origin: embed route unserved, classic overlay still injected", async () => {
    const embed = await fetch(harness.url + "/__nitpicker-harness/embed");
    expect(await embed.text()).not.toContain('data-nitpicker-harness="embed"');
    const app = await fetch(harness.url + "/");
    expect(await app.text()).toContain('data-nitpicker-harness="overlay"');
  });
});
