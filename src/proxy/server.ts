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
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
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
    ws: true,
    xfwd: true,
  });

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
  server.on("upgrade", (req, socket, head) => {
    proxy.ws(req, socket, head);
  });

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
