// Unit tests for the harness's HTML/header rewriting — the only novel logic on the proxy path (the
// overlay + sidecar are reused nitpicker code, covered by vendor/nitpicker/tests). Pure functions, no
// server needed.
import { describe, it, expect } from "vitest";
import {
  injectOverlay,
  overlayScriptTag,
  rewriteAbsoluteUrls,
  relaxCsp,
  relaxSecurityHeaders,
  shellPage,
  builderPage,
  suppressesOverlay,
  NO_OVERLAY_PARAM,
  OVERLAY_PATH,
  SHELL_JS_PATH,
} from "../src/proxy/inject";

const CFG = { session: "demo", endpoint: "http://127.0.0.1:5178" };

describe("overlayScriptTag", () => {
  it("carries session + endpoint on the query string and the marker attribute", () => {
    const tag = overlayScriptTag(CFG);
    expect(tag).toContain(OVERLAY_PATH);
    expect(tag).toContain("session=demo");
    expect(tag).toContain("endpoint=http%3A%2F%2F127.0.0.1%3A5178");
    expect(tag).toContain('data-nitpicker-harness="overlay"');
  });
});

describe("injectOverlay", () => {
  it("splices the script just before </body>", () => {
    const html = "<html><head></head><body><h1>hi</h1></body></html>";
    const out = injectOverlay(html, CFG);
    expect(out).toContain(OVERLAY_PATH);
    // script sits before the closing body tag
    expect(out.indexOf(OVERLAY_PATH)).toBeLessThan(out.indexOf("</body>"));
    expect(out.indexOf("<h1>hi</h1>")).toBeLessThan(out.indexOf(OVERLAY_PATH));
  });

  it("is case-insensitive about the body tag", () => {
    const html = "<HTML><BODY>x</BODY></HTML>";
    const out = injectOverlay(html, CFG);
    expect(out).toContain(OVERLAY_PATH);
    expect(out.toLowerCase().indexOf(OVERLAY_PATH.toLowerCase())).toBeLessThan(
      out.toLowerCase().indexOf("</body>"),
    );
  });

  it("falls back to </head> when there is no body", () => {
    const html = "<html><head></head></html>";
    const out = injectOverlay(html, CFG);
    expect(out).toContain(OVERLAY_PATH);
    expect(out.indexOf(OVERLAY_PATH)).toBeLessThan(out.indexOf("</head>"));
  });

  it("appends when there is neither body nor head", () => {
    const out = injectOverlay("<div>bare</div>", CFG);
    expect(out.startsWith("<div>bare</div>")).toBe(true);
    expect(out).toContain(OVERLAY_PATH);
  });

  it("is idempotent — never injects twice", () => {
    const once = injectOverlay("<body>x</body>", CFG);
    const twice = injectOverlay(once, CFG);
    expect(twice).toBe(once);
    expect(twice.match(/data-nitpicker-harness="overlay"/g)?.length).toBe(1);
  });
});

describe("shellPage", () => {
  it("embeds the same-origin app iframe and the shell bundle carrying config", () => {
    const html = shellPage(CFG);
    expect(html).toContain("<!doctype html>");
    // the app is embedded as a same-origin iframe rooted at the harness origin
    expect(html).toContain('<iframe id="nh-frame" src="/"');
    // the shell bundle is loaded with session + endpoint on the query string (no inline script)
    expect(html).toContain(SHELL_JS_PATH);
    expect(html).toContain("session=demo");
    expect(html).toContain("endpoint=http%3A%2F%2F127.0.0.1%3A5178");
    expect(html).toContain('data-nitpicker-harness="shell"');
    // the chrome mount points the entry wires onto are present
    expect(html).toContain('id="nh-chat"');
    expect(html).toContain('id="nh-queue"');
    expect(html).toContain('id="nh-send-btn"');
    // Phase 2 — the interaction-mode toolbar the entry wires onto (cursor / region / element)
    expect(html).toContain('id="nh-mode-cursor"');
    expect(html).toContain('id="nh-mode-region"');
    expect(html).toContain('id="nh-mode-element"');
  });

  it("escapes the session id so it cannot break out of the markup", () => {
    const html = shellPage({ session: `x"<img>`, endpoint: "http://127.0.0.1:5178" });
    expect(html).not.toContain(`x"<img>`);
    expect(html).toContain("x&quot;&lt;img&gt;");
  });
});

describe("overlay suppression (embedded builder)", () => {
  it("builderPage loads its iframe with the no-overlay flag; shellPage does not", () => {
    const build = builderPage(CFG);
    expect(build).toContain(`<iframe id="nh-frame" src="/?${NO_OVERLAY_PARAM}=1"`);
    // The classic shell keeps the plain src — its behavior is preserved (still gets the injected overlay).
    expect(shellPage(CFG)).toContain('<iframe id="nh-frame" src="/"');
  });

  it("suppressesOverlay is true only for a request carrying the flag", () => {
    expect(suppressesOverlay(`/?${NO_OVERLAY_PARAM}=1`)).toBe(true);
    expect(suppressesOverlay(`/some/route?a=1&${NO_OVERLAY_PARAM}=1`)).toBe(true);
    expect(suppressesOverlay("/")).toBe(false);
    expect(suppressesOverlay("/?other=1")).toBe(false);
    expect(suppressesOverlay(undefined)).toBe(false);
    // A route literally named like the flag but without the query separator must NOT match.
    expect(suppressesOverlay(`/${NO_OVERLAY_PARAM}=1`)).toBe(false);
  });
});

describe("rewriteAbsoluteUrls", () => {
  it("maps absolute target-origin URLs back through the harness origin", () => {
    const html = `<img src="http://localhost:3000/logo.png"><a href="http://localhost:3000/next">n</a>`;
    const out = rewriteAbsoluteUrls(html, "http://localhost:3000", "http://127.0.0.1:4000");
    expect(out).not.toContain("localhost:3000");
    expect(out).toContain("http://127.0.0.1:4000/logo.png");
    expect(out).toContain("http://127.0.0.1:4000/next");
  });

  it("covers the 127.0.0.1 spelling of a localhost target", () => {
    const html = `<script src="http://127.0.0.1:3000/app.js"></script>`;
    const out = rewriteAbsoluteUrls(html, "http://localhost:3000", "http://127.0.0.1:4000");
    expect(out).toContain("http://127.0.0.1:4000/app.js");
    expect(out).not.toContain(":3000");
  });

  it("leaves root-relative URLs untouched (they already route through the proxy)", () => {
    const html = `<script src="/_next/static/chunk.js"></script>`;
    const out = rewriteAbsoluteUrls(html, "http://localhost:3000", "http://127.0.0.1:4000");
    expect(out).toBe(html);
  });

  it("does not rewrite a sibling origin that merely shares a port prefix", () => {
    const html = `<a href="http://localhost:30000/x">sib</a>`;
    const out = rewriteAbsoluteUrls(html, "http://localhost:3000", "http://127.0.0.1:4000");
    expect(out).toBe(html);
  });

  it("rewrites a bare origin with no trailing path", () => {
    const html = `origin is http://localhost:3000`;
    const out = rewriteAbsoluteUrls(html, "http://localhost:3000", "http://127.0.0.1:4000");
    expect(out).toBe("origin is http://127.0.0.1:4000");
  });
});

describe("relaxCsp", () => {
  it("drops frame-ancestors so the harness can frame the page", () => {
    const out = relaxCsp("default-src 'self'; frame-ancestors 'none'", "http://127.0.0.1:5178");
    expect(out).not.toMatch(/frame-ancestors/i);
  });

  it("appends the sidecar origin + unsafe-inline to script-src and connect-src", () => {
    const out = relaxCsp(
      "script-src 'self'; connect-src 'self'",
      "http://127.0.0.1:5178",
    );
    expect(out).toMatch(/script-src 'self' http:\/\/127\.0\.0\.1:5178 'unsafe-inline'/);
    expect(out).toMatch(/connect-src 'self' http:\/\/127\.0\.0\.1:5178/);
  });

  it("adds 'self' to a script-src that omits it (external overlay needs a source expression)", () => {
    const out = relaxCsp("script-src https://cdn.example.com", "http://127.0.0.1:5178");
    // existing source is preserved...
    expect(out).toContain("https://cdn.example.com");
    // ...and 'self' + the sidecar origin are added so the external overlay script loads.
    expect(out).toMatch(/script-src[^;]*'self'/);
    expect(out).toContain("http://127.0.0.1:5178");
  });

  it("does not duplicate 'self' when script-src already carries it", () => {
    const out = relaxCsp("script-src 'self'", "http://127.0.0.1:5178");
    expect(out.match(/'self'/g)?.length).toBe(1);
  });

  it("adds 'self' to default-src when it stands in for an absent script-src", () => {
    const out = relaxCsp("default-src https://cdn.example.com", "http://127.0.0.1:5178");
    expect(out).toMatch(/default-src[^;]*'self'/);
    expect(out).toContain("https://cdn.example.com");
  });

  it("widens default-src when there is no explicit script/connect-src", () => {
    const out = relaxCsp("default-src 'self'", "http://127.0.0.1:5178");
    expect(out).toMatch(/default-src 'self' http:\/\/127\.0\.0\.1:5178 'unsafe-inline'/);
  });

  it("synthesizes an explicit connect-src (inheriting default-src) when connect-src is absent", () => {
    const out = relaxCsp("default-src 'self'; script-src 'self'", "http://127.0.0.1:5178");
    // script-src present, so default-src is NOT widened for scripts...
    expect(out).toMatch(/script-src 'self' http:\/\/127\.0\.0\.1:5178 'unsafe-inline'/);
    expect(out).toMatch(/default-src 'self'(;|$)/);
    // ...but connect-src must still be synthesized so the overlay can reach the sidecar.
    expect(out).toMatch(/connect-src 'self' http:\/\/127\.0\.0\.1:5178 'unsafe-inline'/);
  });

  it("does not synthesize a connect-src when neither connect-src nor default-src is present", () => {
    // Connections were entirely unrestricted; synthesizing one would TIGHTEN the policy and break the
    // app's own fetch/XHR and same-origin HMR websocket.
    const out = relaxCsp("script-src 'self'", "http://127.0.0.1:5178");
    expect(out).toMatch(/script-src 'self' http:\/\/127\.0\.0\.1:5178 'unsafe-inline'/);
    expect(out).not.toMatch(/connect-src/i);
  });

  it("appends 'unsafe-inline' to an explicit style-src (overlay shadow-DOM inline <style>)", () => {
    const out = relaxCsp("style-src 'self'", "http://127.0.0.1:5178");
    expect(out).toMatch(/style-src 'self' 'unsafe-inline'/);
  });

  it("synthesizes an explicit style-src (inheriting default-src) when style-src is absent", () => {
    // A bare `default-src 'self'` leaves the overlay's inline <style> blocked — synthesize style-src.
    const out = relaxCsp("default-src 'self'", "http://127.0.0.1:5178");
    expect(out).toMatch(/style-src 'self' 'unsafe-inline'/);
  });

  it("does not synthesize a style-src when neither style-src nor default-src is present", () => {
    // Inline styles were entirely unrestricted; synthesizing one would TIGHTEN the policy.
    const out = relaxCsp("script-src 'self'", "http://127.0.0.1:5178");
    expect(out).not.toMatch(/style-src/i);
  });
});

describe("relaxSecurityHeaders", () => {
  it("deletes X-Frame-Options regardless of header casing", () => {
    const headers: Record<string, string | string[] | undefined> = {
      "X-Frame-Options": "DENY",
      "content-type": "text/html",
    };
    relaxSecurityHeaders(headers, "http://127.0.0.1:5178");
    expect(headers["X-Frame-Options"]).toBeUndefined();
    expect(headers["content-type"]).toBe("text/html");
  });

  it("relaxes a CSP header in place", () => {
    const headers: Record<string, string | string[] | undefined> = {
      "content-security-policy": "frame-ancestors 'none'; connect-src 'self'",
    };
    relaxSecurityHeaders(headers, "http://127.0.0.1:5178");
    const csp = String(headers["content-security-policy"]);
    expect(csp).not.toMatch(/frame-ancestors/i);
    expect(csp).toContain("http://127.0.0.1:5178");
  });
});
