// nitpicker-harness — the reverse proxy. Fronts a target localhost dev server under the harness's own
// origin, injecting the reused @nitpicker/core overlay into every streamed HTML response so it runs
// same-origin with the app (full DOM access → region/element/selector/component all work with zero code
// in the target repo).
//
// What it does, per the viability report §3a / §6 Phase 1:
//   • pipe every request/response to/from the target dev server (http-proxy)
//   • rewrite `text/html` bodies: inject the overlay <script>, map absolute target-origin URLs back
//     through the harness, and (via relaxSecurityHeaders) strip framing headers + relax CSP
//   • proxy the HMR WebSocket (upgrade requests) so hot-reload survives
//   • serve the bundled overlay JS at `/__nitpicker-harness/overlay.js`
import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy";
import { buildOverlay } from "../overlay/build";
import {
  HARNESS_PREFIX,
  OVERLAY_PATH,
  injectOverlay,
  relaxSecurityHeaders,
  rewriteAbsoluteUrls,
  type InjectConfig,
} from "./inject";

export interface HarnessOptions {
  /** target dev server, e.g. http://localhost:3000 */
  target: string;
  /** port the harness listens on */
  port: number;
  /** sidecar session id */
  session: string;
  /** sidecar base URL the injected overlay POSTs to */
  endpoint: string;
  /** host to bind (default 127.0.0.1) */
  host?: string;
  /** optional log sink (default console.log); set to a no-op to silence */
  log?: (msg: string) => void;
}

export interface Harness {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

/** Start the proxy harness. Resolves once it is listening. */
export function startHarness(opts: HarnessOptions): Promise<Harness> {
  const host = opts.host ?? "127.0.0.1";
  const log = opts.log ?? ((m: string) => process.stdout.write(m + "\n"));
  const targetOrigin = new URL(opts.target).origin;
  const harnessOrigin = `http://${host}:${opts.port}`;
  const sidecarOrigin = safeOrigin(opts.endpoint);
  const injectCfg: InjectConfig = { session: opts.session, endpoint: opts.endpoint };

  const proxy = httpProxy.createProxyServer({
    target: opts.target,
    changeOrigin: true,
    // We rewrite HTML bodies ourselves, so http-proxy hands us the raw upstream response.
    selfHandleResponse: true,
    // WebSocket upgrades are handled by forwardUpgrade() below, NOT http-proxy's ws pass — see the
    // note on server.on("upgrade"). So `ws` stays off here.
    xfwd: true,
  });
  const targetUrl = new URL(opts.target);

  // Ask the target for identity encoding so we can inject into a plain-text HTML body without having to
  // gunzip/re-gzip. Dev servers rarely compress, but this makes it deterministic.
  proxy.on("proxyReq", (proxyReq) => {
    proxyReq.setHeader("accept-encoding", "identity");
  });

  proxy.on("proxyRes", (proxyRes, req, res) => {
    const headers = { ...proxyRes.headers };
    relaxSecurityHeaders(headers, sidecarOrigin);
    const contentType = String(proxyRes.headers["content-type"] ?? "");

    if (contentType.includes("text/html")) {
      const chunks: Buffer[] = [];
      let settled = false;
      const onUpstreamError = (err: Error) => {
        if (settled) return;
        settled = true;
        log(`[nitpicker-harness] upstream HTML stream error: ${err.message}`);
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`nitpicker-harness: upstream ${opts.target} failed mid-response (${err.message})`);
      };
      proxyRes.on("data", (c: Buffer) => chunks.push(c));
      proxyRes.on("error", onUpstreamError);
      proxyRes.on("aborted", () => onUpstreamError(new Error("upstream aborted")));
      proxyRes.on("end", () => {
        if (settled) return;
        settled = true;
        let body = Buffer.concat(chunks).toString("utf8");
        body = rewriteAbsoluteUrls(body, targetOrigin, harnessOrigin);
        body = injectOverlay(body, injectCfg);
        // Body length changed (and any upstream chunked/encoding no longer applies) — reset framing.
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        delete headers["content-encoding"];
        headers["content-length"] = String(Buffer.byteLength(body));
        res.writeHead(proxyRes.statusCode ?? 200, headers as Record<string, string | string[]>);
        res.end(body);
      });
      return;
    }

    // Non-HTML: forward status + (relaxed) headers verbatim and stream the body through untouched.
    // pipe() attaches no error handler to the source, so guard proxyRes ourselves — an upstream drop
    // mid-asset would otherwise emit an unhandled 'error' and crash the whole harness process.
    let settled = false;
    const onUpstreamError = (err: Error) => {
      if (settled) return;
      settled = true;
      log(`[nitpicker-harness] upstream asset stream error: ${err.message}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`nitpicker-harness: upstream ${opts.target} failed mid-response (${err.message})`);
    };
    proxyRes.on("error", onUpstreamError);
    proxyRes.on("aborted", () => onUpstreamError(new Error("upstream aborted")));
    res.writeHead(proxyRes.statusCode ?? 200, headers as Record<string, string | string[]>);
    proxyRes.pipe(res);
  });

  proxy.on("error", (err, _req, resOrSocket) => {
    log(`[nitpicker-harness] proxy error: ${(err as Error).message}`);
    const res = resOrSocket as ServerResponse;
    if (res && "writeHead" in res && !res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`nitpicker-harness: upstream ${opts.target} unreachable (${(err as Error).message})`);
    } else if (resOrSocket && "destroy" in resOrSocket) {
      (resOrSocket as { destroy: () => void }).destroy();
    }
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", harnessOrigin);
    if (url.pathname === OVERLAY_PATH) return void serveOverlay(res, log);
    if (url.pathname === `${HARNESS_PREFIX}/health`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "nitpicker-harness", target: opts.target }));
      return;
    }
    proxy.web(req, res);
  });

  // HMR / any target WebSocket: forward the upgrade so hot-reload survives the proxy.
  //
  // We do NOT use http-proxy's `proxy.ws()` here. http-proxy@1.18.1's WebSocket pass leaves the outgoing
  // client-request's HTTP parser attached to the upgraded socket; the first inbound WebSocket frame is
  // then fed to that parser, which throws `Parse Error: Expected HTTP/` and tears the socket down *before*
  // the 101 handshake is relayed to the browser. Against Next 16 / Turbopack that manifests as the browser
  // console error "WebSocket connection to '…/_next/webpack-hmr' failed: Connection closed before receiving
  // a handshake response", and — critically — the stalled dev socket wedges Turbopack's runtime so client
  // hydration never completes and per-node React fibers never attach (breaking element→component name).
  // (This worked on Next 15 / webpack by luck of timing; Turbopack's HMR runtime hard-depends on the socket.)
  //
  // forwardUpgrade() below is a plain raw-socket tunnel: open the same upgrade request to the target, relay
  // its 101 + headers back verbatim, then pipe bytes both ways with no HTTP parser in the middle.
  server.on("upgrade", (req, socket, head) => {
    forwardUpgrade(req, socket as Duplex, head);
  });

  /** Forward a WebSocket (or any) HTTP upgrade to the target and tunnel the raw socket both ways. */
  function forwardUpgrade(req: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    // pipe() attaches no error handler to either end; a mid-tunnel drop would otherwise crash the process.
    clientSocket.on("error", () => clientSocket.destroy());

    const requestFn = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
    // Mirror the web proxy's changeOrigin: rewrite Host to the target so the dev server sees its own origin.
    const headers = { ...req.headers, host: targetUrl.host };
    // Next 16 / Turbopack's dev server rejects the `/_next/webpack-hmr` upgrade with a raw "Unauthorized"
    // (not even a valid HTTP response — that's the `Parse Error: Expected HTTP/` upstream) whenever the
    // request carries an `Origin` outside its dev-origin allowlist. The browser always sends the *harness*
    // origin (e.g. http://127.0.0.1:4222), which never matches the target — and even the target's own
    // 127.0.0.1 origin is rejected (only `localhost`/LAN hosts are allowlisted by default). A forwarded
    // reverse-proxy upgrade is a trusted server-to-server hop, so strip `Origin` entirely: with no Origin
    // the dev server treats it as same-origin and returns `101 Switching Protocols`. Without this the HMR
    // socket never connects and Turbopack's runtime stalls before client hydration attaches per-node React
    // fibers (breaking element→component-name resolution). Verified: any Origin → "Unauthorized"; none → 101.
    delete headers.origin;
    const proxyReq = requestFn({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      method: req.method,
      path: req.url,
      headers,
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket: Duplex, proxyHead: Buffer) => {
      // Tie the two sockets' lifetimes together — HMR reconnects often, so a half-open peer left behind on
      // every drop would slowly leak file descriptors over a long dev session.
      proxySocket.on("error", () => clientSocket.destroy());
      proxySocket.on("close", () => clientSocket.destroy());
      clientSocket.on("close", () => proxySocket.destroy());
      // Relay the target's handshake response (e.g. `101 Switching Protocols` + Sec-WebSocket-Accept)
      // byte-for-byte, then splice the two sockets. rawHeaders preserves order/casing/duplicates.
      const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`;
      const headerLines: string[] = [];
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        headerLines.push(`${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}`);
      }
      clientSocket.write(`${statusLine}\r\n${headerLines.join("\r\n")}\r\n\r\n`);
      // Early bytes that arrived alongside each handshake, in their correct direction.
      if (proxyHead && proxyHead.length) clientSocket.write(proxyHead); // target → browser
      if (head && head.length) proxySocket.write(head); // browser → target
      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);
    });

    // The target answered without upgrading (e.g. 404/426). Relay the status line + headers so the browser
    // sees the real rejection instead of a bare socket close, then end the tunnel.
    proxyReq.on("response", (proxyRes) => {
      if (proxyRes.headers.upgrade) return; // handled by the 'upgrade' listener above
      const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`;
      const headerLines: string[] = [];
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        headerLines.push(`${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}`);
      }
      clientSocket.write(`${statusLine}\r\n${headerLines.join("\r\n")}\r\n\r\n`);
      // pipe() attaches no error handler to the source; an upstream body error/abort mid-stream would
      // otherwise emit an unhandled 'error' on proxyRes and crash the harness. Tear the tunnel down instead.
      proxyRes.on("error", () => clientSocket.destroy());
      proxyRes.on("aborted", () => clientSocket.destroy());
      proxyRes.pipe(clientSocket);
    });

    proxyReq.on("error", (err) => {
      log(`[nitpicker-harness] ws upgrade error: ${err.message}`);
      clientSocket.destroy();
    });

    proxyReq.end();
  }

  return new Promise<Harness>((resolve) => {
    server.listen(opts.port, host, () => {
      resolve({
        server,
        url: harnessOrigin,
        close: () =>
          new Promise<void>((r) => {
            proxy.close();
            server.close(() => r());
          }),
      });
    });
  });
}

async function serveOverlay(res: ServerResponse, log: (m: string) => void): Promise<void> {
  try {
    const js = await buildOverlay();
    res.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.end(js);
  } catch (err) {
    const message = (err as Error).message;
    log(`[nitpicker-harness] overlay bundle failed: ${message}`);
    res.writeHead(500, { "content-type": "application/javascript" });
    res.end(`console.error(${JSON.stringify(`nitpicker-harness overlay build failed: ${message}`)});`);
  }
}

function safeOrigin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return u;
  }
}
