// @vitest-environment node
//
// Regression test for the Phase-0 proxy hydration/HMR fix (src/proxy/server.ts `forwardUpgrade`).
//
// Next 16 / Turbopack's dev server rejects the `/_next/webpack-hmr` WebSocket upgrade with a raw,
// non-HTTP "Unauthorized" whenever the request carries an `Origin` header outside its dev-origin
// allowlist — and the browser, going through the harness, always sends the *harness* origin, which never
// matches. The old code forwarded that upgrade via http-proxy's ws pass (which additionally choked on the
// raw reply with `Parse Error: Expected HTTP/`), so the HMR socket never connected, Turbopack's runtime
// stalled, and client hydration never attached per-node React fibers.
//
// The fixes under test: (1) a hand-rolled raw-socket upgrade tunnel replacing http-proxy's ws pass, and
// (2) stripping `Origin` on the forwarded upgrade so the dev server accepts it. This test fakes a target
// that mimics Turbopack's behaviour exactly — reject-on-Origin, else 101 + echo — and asserts the browser
// still gets a working socket through the harness.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { startHarness, type Harness } from "../src/proxy/server";

let target: Server;
let harness: Harness;
/** Origin header value the fake target saw on the forwarded upgrade (undefined = stripped, as required). */
let seenUpgradeOrigin: string | null | undefined;
/** Every TCP socket the target accepted — upgraded sockets are hijacked and would otherwise keep the
 *  server's close() hanging, so we track and force-destroy them in afterAll. */
const targetSockets = new Set<Socket>();

beforeAll(async () => {
  target = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>ok</body></html>");
  });
  target.on("connection", (s) => {
    targetSockets.add(s);
    s.on("close", () => targetSockets.delete(s));
  });

  // Mimic Next 16 / Turbopack's HMR endpoint: reject any upgrade that still carries an Origin with a raw
  // (non-HTTP) "Unauthorized" + close; otherwise complete the 101 handshake and echo bytes back.
  target.on("upgrade", (req, socket: Duplex, head: Buffer) => {
    seenUpgradeOrigin = req.headers.origin ?? null;
    if (req.headers.origin) {
      socket.write("Unauthorized");
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    if (head && head.length) socket.write(head); // echo any early client bytes
    socket.on("data", (d: Buffer) => socket.write(d)); // echo subsequent bytes
  });

  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const targetPort = (target.address() as AddressInfo).port;

  harness = await startHarness({
    target: `http://127.0.0.1:${targetPort}`,
    port: 0 as unknown as number,
    session: "demo",
    endpoint: "http://127.0.0.1:5178",
    log: () => {},
  });
  const bound = (harness.server.address() as AddressInfo).port;
  harness.url = `http://127.0.0.1:${bound}`;
}, 30_000);

afterAll(async () => {
  // Upgraded (tunneled) sockets are hijacked from both servers, so a bare close() would hang waiting on
  // them — force every side shut first.
  harness.server.closeAllConnections?.();
  for (const s of targetSockets) s.destroy();
  await harness.close();
  await new Promise<void>((r) => target.close(() => r()));
});

/** Open a raw HTTP upgrade to the harness with a browser-style Origin; resolve the tunneled socket. */
function upgradeThroughHarness(): Promise<{ statusCode: number; socket: Duplex }> {
  const { port } = harness.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/_next/webpack-hmr?id=test",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        // The harness origin — exactly what a browser framing the proxied app sends, and exactly what
        // Turbopack rejects. The fix must strip this before forwarding.
        Origin: `http://127.0.0.1:${port}`,
      },
    });
    req.on("upgrade", (res, socket) => resolve({ statusCode: res.statusCode ?? 0, socket }));
    // A non-upgrade response means the tunnel collapsed (regression) — surface it instead of hanging.
    req.on("response", (res) => reject(new Error(`expected 101 upgrade, got ${res.statusCode}`)));
    req.on("error", reject);
    req.end();
  });
}

describe("proxy harness — WebSocket (HMR) upgrade forwarding", () => {
  it("strips Origin so an Origin-gated dev server (Next 16/Turbopack) completes the 101 handshake", async () => {
    const { statusCode, socket } = await upgradeThroughHarness();
    expect(statusCode).toBe(101);
    // The forwarded upgrade must have carried NO Origin — that is what makes Turbopack accept it.
    expect(seenUpgradeOrigin).toBeNull();
    socket.destroy();
  });

  it("tunnels bytes in both directions after the handshake", async () => {
    const { socket } = await upgradeThroughHarness();
    const echoed = await new Promise<string>((resolve, reject) => {
      socket.once("data", (d: Buffer) => resolve(d.toString("utf8")));
      socket.once("error", reject);
      socket.write("ping-through-proxy");
    });
    expect(echoed).toBe("ping-through-proxy");
    socket.destroy();
  });
});
