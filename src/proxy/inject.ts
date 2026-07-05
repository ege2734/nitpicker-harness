// nitpicker-harness — the pure HTML/header rewriting layer of the reverse proxy. Kept dependency-free
// and side-effect-free so it is directly unit-testable: the proxy server (server.ts) wires these into
// the streamed request/response cycle.
//
// Responsibilities:
//   • injectOverlay  — splice the overlay <script> into a proxied HTML document
//   • rewriteAbsoluteUrls — map absolute target-origin URLs in the HTML back through the harness origin
//   • relaxSecurityHeaders — strip X-Frame-Options + CSP frame-ancestors and relax script-src/connect-src
//                            so the page frames same-origin under the harness and the overlay can reach
//                            the sidecar
//
// The proxy path served for harness-internal assets. Chosen to be unlikely to collide with a target's
// own routes.
export const HARNESS_PREFIX = "/__nitpicker-harness";
export const OVERLAY_PATH = `${HARNESS_PREFIX}/overlay.js`;

export interface InjectConfig {
  /** sidecar session id (matched by `nitpicker-harness poll --session <id>`). */
  session: string;
  /** sidecar base URL the overlay POSTs feedback to (default http://127.0.0.1:5178). */
  endpoint: string;
}

/** The single external <script> tag the injector splices in. Config rides on the query string so no
 *  inline script is required (a page with `script-src 'self'` still runs it once the origin is ours). */
export function overlayScriptTag(cfg: InjectConfig): string {
  const q = new URLSearchParams({ session: cfg.session, endpoint: cfg.endpoint }).toString();
  return `<script src="${OVERLAY_PATH}?${q}" data-nitpicker-harness="overlay"></script>`;
}

/** Insert the overlay script into an HTML document. Prefers just before </body>; falls back to </head>,
 *  then to appending. Idempotent: a document that already carries the overlay tag is returned unchanged
 *  (guards against a target that server-renders and streams the same shell twice). */
export function injectOverlay(html: string, cfg: InjectConfig): string {
  if (html.includes('data-nitpicker-harness="overlay"')) return html;
  const tag = overlayScriptTag(cfg);
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose !== -1) {
    return html.slice(0, bodyClose) + tag + html.slice(bodyClose);
  }
  const headClose = html.toLowerCase().indexOf("</head>");
  if (headClose !== -1) {
    return html.slice(0, headClose) + tag + html.slice(headClose);
  }
  return html + tag;
}

/**
 * Rewrite absolute URLs that point at the target's own origin back through the harness origin, so the
 * browser fetches them via the proxy (same-origin) rather than hitting the target directly (which would
 * escape the harness and, for assets, reintroduce a cross-origin boundary). Root-relative URLs
 * (`/_next/...`) already route through the proxy and are left untouched.
 *
 * `targetOrigin` and `harnessOrigin` are bare origins like `http://localhost:3000`. Both http/https and
 * the localhost/127.0.0.1 spellings of the target are covered.
 */
export function rewriteAbsoluteUrls(
  html: string,
  targetOrigin: string,
  harnessOrigin: string,
): string {
  let out = html;
  for (const variant of originVariants(targetOrigin)) {
    if (variant === harnessOrigin) continue;
    // Only rewrite an occurrence at a real URL boundary — the origin followed by a path/quote/whitespace/
    // '<' or end-of-string — so `http://localhost:3000` doesn't corrupt the prefix of
    // `http://localhost:30000/...` or unrelated text that merely contains the origin string.
    const re = new RegExp(`${escapeRegExp(variant)}(?=[/"'\`\\s<>?#]|$)`, "g");
    out = out.replace(re, harnessOrigin);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** localhost/127.0.0.1 and http/https spellings of an origin, so a target that emits either is caught. */
function originVariants(origin: string): string[] {
  const set = new Set<string>([origin]);
  try {
    const u = new URL(origin);
    const hosts =
      u.hostname === "localhost"
        ? ["localhost", "127.0.0.1"]
        : u.hostname === "127.0.0.1"
          ? ["127.0.0.1", "localhost"]
          : [u.hostname];
    for (const h of hosts) set.add(`${u.protocol}//${h}${u.port ? `:${u.port}` : ""}`);
  } catch {
    // non-URL origin string — just use it verbatim
  }
  return [...set];
}

/**
 * Relax response security headers so the proxied page runs same-origin under the harness with the
 * injected overlay able to reach the sidecar:
 *   • delete `X-Frame-Options` (would block framing entirely)
 *   • from any `Content-Security-Policy`: drop `frame-ancestors` (blocks framing; modern browsers honor
 *     it over X-Frame-Options), and append the sidecar origin + `'unsafe-inline'`/`blob:` to
 *     `script-src`/`connect-src`/`default-src` so the overlay script runs and can POST feedback.
 *
 * Mutates and returns the same headers object (Node's outgoing-header bag). Header names are matched
 * case-insensitively.
 */
export function relaxSecurityHeaders(
  headers: Record<string, string | string[] | undefined>,
  sidecarOrigin: string,
): Record<string, string | string[] | undefined> {
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower === "x-frame-options") {
      delete headers[key];
      continue;
    }
    if (lower === "content-security-policy" || lower === "content-security-policy-report-only") {
      const val = headers[key];
      const relaxed = Array.isArray(val)
        ? val.map((v) => relaxCsp(v, sidecarOrigin))
        : relaxCsp(String(val), sidecarOrigin);
      headers[key] = relaxed;
    }
  }
  return headers;
}

/** Relax a single CSP header string. Exported for direct unit testing. */
export function relaxCsp(csp: string, sidecarOrigin: string): string {
  const extra = `${sidecarOrigin} 'unsafe-inline' blob: data:`;
  const directives = csp
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    // frame-ancestors blocks the harness from framing the page — drop it outright.
    .filter((d) => !/^frame-ancestors\b/i.test(d));

  const names = directives.map((d) => d.split(/\s+/, 1)[0].toLowerCase());
  const hasScriptSrc = names.includes("script-src");

  // The overlay is an EXTERNAL same-origin script; 'unsafe-inline' does not authorize it — only source
  // expressions do — so any directive that governs the overlay script must also carry 'self' (the harness
  // origin under the proxy). Additive only: 'self' is appended when absent, never removing existing sources.
  const widenForScript = (d: string): string => {
    const widened = `${d} ${extra}`;
    return /(^|\s)'self'(\s|$)/i.test(d) ? widened : `${widened} 'self'`;
  };

  const relaxed = directives.map((d) => {
    const name = d.split(/\s+/, 1)[0].toLowerCase();
    if (name === "script-src" || name === "script-src-elem") {
      return widenForScript(d);
    }
    if (name === "connect-src") {
      return `${d} ${extra}`;
    }
    // The overlay mounts a shadow DOM with an inline <style>; 'unsafe-inline' authorizes it. Additive only.
    if (name === "style-src" || name === "style-src-elem") {
      return `${d} 'unsafe-inline'`;
    }
    // If there's no explicit script-src, the overlay script falls back to default-src — widen it so the
    // external overlay script isn't blocked (needs 'self' too, not just 'unsafe-inline').
    if (name === "default-src" && !hasScriptSrc) {
      return widenForScript(d);
    }
    return d;
  });

  // connect-src falls back to default-src, which a bare `default-src 'self'` (or a policy that sets
  // script-src but not connect-src) leaves too narrow for the overlay's POST to the sidecar — synthesize an
  // explicit connect-src that inherits default-src's sources plus the sidecar origin. But when there's no
  // default-src to inherit from either, connections were entirely unrestricted; synthesizing one here would
  // TIGHTEN the policy (breaking the app's own fetch/XHR and same-origin HMR), so leave connect untouched.
  if (!names.includes("connect-src")) {
    const defaultSrc = directives.find((d) => d.split(/\s+/, 1)[0].toLowerCase() === "default-src");
    if (defaultSrc) {
      const inherited = defaultSrc.split(/\s+/).slice(1).join(" ");
      relaxed.push(`connect-src ${inherited ? `${inherited} ` : ""}${extra}`);
    }
  }

  // The overlay's inline <style> falls back to default-src when no style-src is present, which a bare
  // `default-src 'self'` leaves too narrow — synthesize an explicit style-src that inherits default-src's
  // sources plus 'unsafe-inline'. As with connect-src, if there's no default-src either then inline styles
  // were entirely unrestricted; synthesizing here would TIGHTEN the policy, so leave styles untouched.
  if (!names.includes("style-src")) {
    const defaultSrc = directives.find((d) => d.split(/\s+/, 1)[0].toLowerCase() === "default-src");
    if (defaultSrc) {
      const inherited = defaultSrc.split(/\s+/).slice(1).join(" ");
      relaxed.push(`style-src ${inherited ? `${inherited} ` : ""}'unsafe-inline'`);
    }
  }

  return relaxed.join("; ");
}
