// nitpicker-harness — the pure HTML/header rewriting layer of the reverse proxy. Kept dependency-free
// and side-effect-free so it is directly unit-testable: the proxy server (server.ts) wires these into
// the streamed request/response cycle.
//
// Responsibilities:
//   • injectOverlay  — splice the overlay <script> into a proxied HTML document
//   • rewriteAbsoluteUrls — map absolute target-origin URLs in the HTML back through the harness origin
//   • relaxSecurityHeaders — strip X-Frame-Options + CSP frame-ancestors and relax
//                            script-src/connect-src/style-src so the page frames same-origin under the
//                            harness and the overlay can run, reach the sidecar, and style its shadow DOM
//
// The proxy path served for harness-internal assets. Chosen to be unlikely to collide with a target's
// own routes.
export const HARNESS_PREFIX = "/__nitpicker-harness";
export const OVERLAY_PATH = `${HARNESS_PREFIX}/overlay.js`;
// The "builder shell" mode (viability report §6 / Phase 1): a page served from the harness origin that
// embeds the proxied app in a same-origin <iframe> and hosts the chat + queue in the PARENT window, so
// persistence across in-iframe navigation is structural (the chrome lives outside the app frame). This
// is additive — the injected `overlay.js` "feedback proxy" mode above stays as the fallback.
export const SHELL_PATH = `${HARNESS_PREFIX}/shell`;
export const SHELL_JS_PATH = `${HARNESS_PREFIX}/shell.js`;
// The "embedded builder" mode (hz-agent §2, loom-decision D7): a SIBLING of the builder-shell that swaps the
// queue→sidecar sink for a LIVE agent — the pane IS the agent you build with, streaming its turn over the
// Agent Gateway's SSE channel while the preview HMRs on the agent's own file edits. Additive: the shell
// above (and its sidecar/poll consumers) are byte-for-byte unchanged.
export const BUILD_PATH = `${HARNESS_PREFIX}/build`;
export const BUILD_JS_PATH = `${HARNESS_PREFIX}/build.js`;
// Overlay-suppression is MODE-gated, not per-request: in EMBEDDED/BUILDER mode (server.ts `builderPane` on)
// the proxy NEVER injects the classic in-frame overlay into the app. The builder pane is the sole interface
// and already drives element-pick / region / inline-edit from the PARENT against its iframe (the reused
// InteractionLayer/Env seam), so an injected dock+queue would be a redundant SECOND feedback UI over the same
// preview. Gating on the mode (not a query flag/cookie on the initial iframe src) is what makes it survive a
// `/`→`/dashboard` redirect and any SPA/full-page navigation the app drives — every app request through an
// embedded harness is suppressed, unconditionally. With `builderPane` OFF (classic feedback-proxy / shell)
// the overlay is injected exactly as before — byte-for-byte unchanged.

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

/** The parent "builder shell" page (served at SHELL_PATH, on the harness origin). It embeds the proxied
 *  app in a same-origin `<iframe src="/">` and loads the shell bundle (SHELL_JS_PATH) which builds the
 *  chat + queue chrome in THIS parent window. Because the chrome lives in the parent heap, it survives any
 *  navigation the iframe does — SPA route change, hard reload, even a cross-origin excursion — with zero
 *  extra work (viability report §3). Config rides on the bundle URL's query string (like the overlay), so
 *  no inline <script> is needed. Pure/string-only so it stays unit-testable. */
export function shellPage(cfg: InjectConfig): string {
  const q = new URLSearchParams({ session: cfg.session, endpoint: cfg.endpoint }).toString();
  const sessionText = escapeHtml(cfg.session);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>nitpicker-harness · builder shell</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; height: 100vh; overflow: hidden;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0b0d10; color: #e6e8eb;
  }
  #nh-stage { position: relative; flex: 1 1 auto; min-width: 0; background: #fff; }
  #nh-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  #nh-chat {
    flex: 0 0 340px; width: 340px; height: 100%; display: flex; flex-direction: column;
    border-left: 1px solid #23272e; background: #14171b;
  }
  .nh-hdr { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #23272e; }
  .nh-hdr .nh-title { font-weight: 600; letter-spacing: .2px; }
  .nh-hdr .nh-sess { margin-left: auto; font-size: 11px; color: #8b929c; }
  /* Phase 2 — mode toolbar: switch the parent-driven interaction over the iframe (cursor / region / element). */
  .nh-modes { display: inline-flex; gap: 2px; margin-left: 4px; padding: 2px; border-radius: 8px; background: #0e1114; border: 1px solid #23272e; }
  .nh-mode { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: #9aa2ac; cursor: pointer; font: inherit; font-size: 12px; line-height: 1; }
  .nh-mode:hover { background: #1f242c; color: #e6e8eb; }
  .nh-mode.nh-active { background: #2b5cff; color: #fff; }
  .nh-count {
    display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px;
    padding: 0 6px; border-radius: 10px; background: #2b5cff; color: #fff; font-size: 11px; font-weight: 600;
  }
  .nh-queue { flex: 1 1 auto; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .nh-empty { color: #6b727c; font-style: italic; padding: 8px 2px; }
  .nh-item { position: relative; padding: 8px 28px 8px 10px; border: 1px solid #262b33; border-radius: 8px; background: #1a1e24; white-space: pre-wrap; word-break: break-word; }
  .nh-item .nh-item-route { display: block; margin-top: 4px; font-size: 10px; color: #6b727c; }
  .nh-item .nh-item-source { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #8a93a0; }
  .nh-item .nh-item-edit { display: block; margin-top: 4px; font-size: 11px; color: #c7cdd6; }
  .nh-item .nh-del { position: absolute; top: 4px; right: 6px; border: 0; background: transparent; color: #6b727c; cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px; }
  .nh-item .nh-del:hover { color: #e06c6c; }
  .nh-compose { border-top: 1px solid #23272e; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .nh-compose textarea {
    resize: none; width: 100%; min-height: 56px; max-height: 160px; padding: 8px 10px; border-radius: 8px;
    border: 1px solid #2b313a; background: #0e1114; color: #e6e8eb; font: inherit;
  }
  .nh-compose textarea:focus { outline: none; border-color: #2b5cff; }
  .nh-row { display: flex; gap: 8px; }
  .nh-btn { flex: 1 1 auto; padding: 8px 10px; border-radius: 8px; border: 1px solid #2b313a; background: #1f242c; color: #e6e8eb; font: inherit; font-weight: 600; cursor: pointer; }
  .nh-btn:hover:not(:disabled) { background: #262c35; }
  .nh-btn:disabled { opacity: .5; cursor: default; }
  .nh-btn.nh-send { background: #2b5cff; border-color: #2b5cff; color: #fff; }
  .nh-btn.nh-send:hover:not(:disabled) { background: #3f6bff; }
  .nh-status { min-height: 16px; font-size: 11px; color: #8b929c; }
  .nh-status.nh-ok { color: #4caf7d; }
  .nh-status.nh-err { color: #e06c6c; }
</style>
</head>
<body>
  <div id="nh-stage"><iframe id="nh-frame" src="/" title="proxied app"></iframe></div>
  <aside id="nh-chat" aria-label="nitpicker feedback">
    <div class="nh-hdr">
      <span class="nh-title">nitpicker</span>
      <span class="nh-modes" role="group" aria-label="feedback mode">
        <button class="nh-mode nh-active" id="nh-mode-cursor" type="button" data-mode="cursor" title="Cursor — passive (Esc)" aria-label="Cursor mode">▧</button>
        <button class="nh-mode" id="nh-mode-region" type="button" data-mode="region" title="Region — drag over the app to screenshot" aria-label="Region mode">⬚</button>
        <button class="nh-mode" id="nh-mode-element" type="button" data-mode="element" title="Element — hover to outline, click to pick a component" aria-label="Element mode">◎</button>
        <button class="nh-mode" id="nh-mode-edit" type="button" data-mode="edit" title="Edit text — click a text element to edit it inline (Enter to save, Esc to cancel)" aria-label="Edit text mode">✎</button>
      </span>
      <span class="nh-count" id="nh-count">0</span>
      <span class="nh-sess">${sessionText}</span>
    </div>
    <div class="nh-queue" id="nh-queue"></div>
    <div class="nh-compose">
      <textarea id="nh-input" placeholder="Describe a change… (Enter to queue, Shift+Enter for newline)"></textarea>
      <div class="nh-row">
        <button class="nh-btn" id="nh-queue-btn" type="button">Queue</button>
        <button class="nh-btn nh-send" id="nh-send-btn" type="button" disabled>Send to agent</button>
      </div>
      <div class="nh-status" id="nh-status"></div>
    </div>
  </aside>
  <script src="${SHELL_JS_PATH}?${q}" data-nitpicker-harness="shell"></script>
</body>
</html>`;
}

/** The embedded builder pane (served at BUILD_PATH, on the harness origin). Same iframe stage + mode
 *  toolbar as the shell, but the right rail is a LIVE agent transcript + composer that POSTs turns to the
 *  Agent Gateway and streams `AgentEvent`s back over SSE (src/builder/entry.ts). Config rides the bundle
 *  URL's query string; no inline <script>. Pure/string-only so it stays unit-testable. */
export function builderPage(cfg: InjectConfig): string {
  const q = new URLSearchParams({ session: cfg.session, endpoint: cfg.endpoint }).toString();
  const sessionText = escapeHtml(cfg.session);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>nitpicker-harness · builder</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; height: 100vh; overflow: hidden;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0b0d10; color: #e6e8eb;
  }
  #nh-stage { position: relative; flex: 1 1 auto; min-width: 0; background: #fff; }
  #nh-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  #nh-chat {
    flex: 0 0 380px; width: 380px; height: 100%; display: flex; flex-direction: column;
    border-left: 1px solid #23272e; background: #14171b;
  }
  .nh-hdr { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #23272e; }
  .nh-hdr .nh-title { font-weight: 600; letter-spacing: .2px; }
  .nh-hdr .nh-dot { width: 8px; height: 8px; border-radius: 50%; background: #6b727c; }
  .nh-hdr .nh-dot.nh-ready { background: #4caf7d; }
  .nh-hdr .nh-dot.nh-busy { background: #e0b34c; }
  .nh-hdr .nh-sess { margin-left: auto; font-size: 11px; color: #8b929c; }
  .nh-modes { display: inline-flex; gap: 2px; margin-left: 4px; padding: 2px; border-radius: 8px; background: #0e1114; border: 1px solid #23272e; }
  .nh-mode { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: #9aa2ac; cursor: pointer; font: inherit; font-size: 12px; line-height: 1; }
  .nh-mode:hover { background: #1f242c; color: #e6e8eb; }
  .nh-mode.nh-active { background: #2b5cff; color: #fff; }
  #nh-transcript { flex: 1 1 auto; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .nh-empty { color: #6b727c; font-style: italic; padding: 8px 2px; }
  .nh-msg { padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
  .nh-msg.nh-user { background: #1c2534; border: 1px solid #26344a; align-self: flex-end; max-width: 92%; }
  .nh-msg.nh-assistant { background: #1a1e24; border: 1px solid #262b33; align-self: flex-start; max-width: 96%; }
  .nh-msg .nh-role { display: block; font-size: 10px; letter-spacing: .4px; text-transform: uppercase; color: #6b727c; margin-bottom: 3px; }
  .nh-tool { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #9aa2ac; padding: 2px 0; }
  .nh-tool .nh-file { color: #7fb0ff; }
  .nh-err { color: #e06c6c; }
  .nh-marks { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px; border-top: 1px solid #23272e; }
  .nh-marks:empty { display: none; }
  .nh-chip { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 4px 22px 4px 8px; border: 1px solid #2b313a; border-radius: 14px; background: #1a1e24; font-size: 11px; max-width: 100%; }
  .nh-chip .nh-src { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #8a93a0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
  .nh-chip .nh-del { position: absolute; right: 4px; top: 2px; border: 0; background: transparent; color: #6b727c; cursor: pointer; font-size: 13px; line-height: 1; }
  .nh-chip .nh-del:hover { color: #e06c6c; }
  /* Markdown-rendered agent replies (src/builder/markdown.ts builds sanitized DOM into .nh-md). */
  .nh-md { font-size: 13px; }
  .nh-md > *:first-child { margin-top: 0; }
  .nh-md > *:last-child { margin-bottom: 0; }
  .nh-md p { margin: 6px 0; }
  .nh-md h1, .nh-md h2, .nh-md h3, .nh-md h4, .nh-md h5, .nh-md h6 { margin: 10px 0 6px; line-height: 1.3; }
  .nh-md h1 { font-size: 16px; } .nh-md h2 { font-size: 15px; } .nh-md h3 { font-size: 14px; }
  .nh-md h4, .nh-md h5, .nh-md h6 { font-size: 13px; }
  .nh-md ul, .nh-md ol { margin: 6px 0; padding-left: 20px; }
  .nh-md li { margin: 2px 0; }
  .nh-md code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #0e1114; border: 1px solid #23272e; border-radius: 4px; padding: 1px 4px; }
  .nh-md pre { background: #0e1114; border: 1px solid #23272e; border-radius: 6px; padding: 8px 10px; overflow-x: auto; margin: 6px 0; }
  .nh-md pre code { background: none; border: 0; padding: 0; }
  .nh-md a { color: #7fb0ff; }
  .nh-md blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid #2b313a; color: #9aa2ac; }
  .nh-md hr { border: 0; border-top: 1px solid #23272e; margin: 8px 0; }
  .nh-compose { border-top: 1px solid #23272e; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .nh-compose textarea {
    resize: none; width: 100%; min-height: 56px; max-height: 160px; padding: 8px 10px; border-radius: 8px;
    border: 1px solid #2b313a; background: #0e1114; color: #e6e8eb; font: inherit;
  }
  .nh-compose textarea:focus { outline: none; border-color: #2b5cff; }
  .nh-row { display: flex; gap: 8px; }
  .nh-btn { flex: 1 1 auto; padding: 8px 10px; border-radius: 8px; border: 1px solid #2b313a; background: #1f242c; color: #e6e8eb; font: inherit; font-weight: 600; cursor: pointer; }
  .nh-btn:hover:not(:disabled) { background: #262c35; }
  .nh-btn:disabled { opacity: .5; cursor: default; }
  .nh-btn.nh-send { background: #2b5cff; border-color: #2b5cff; color: #fff; }
  .nh-btn.nh-send:hover:not(:disabled) { background: #3f6bff; }
  .nh-btn.nh-stop { flex: 0 0 auto; }
  .nh-status { min-height: 16px; font-size: 11px; color: #8b929c; }
  .nh-status.nh-ok { color: #4caf7d; }
  .nh-status.nh-err { color: #e06c6c; }
</style>
</head>
<body>
  <div id="nh-stage"><iframe id="nh-frame" src="/" title="proxied app"></iframe></div>
  <aside id="nh-chat" aria-label="nitpicker builder">
    <div class="nh-hdr">
      <span class="nh-dot" id="nh-dot" title="agent status"></span>
      <span class="nh-title">builder</span>
      <span class="nh-modes" role="group" aria-label="preview mode">
        <button class="nh-mode nh-active" id="nh-mode-cursor" type="button" data-mode="cursor" title="Cursor — passive (Esc)" aria-label="Cursor mode">▧</button>
        <button class="nh-mode" id="nh-mode-region" type="button" data-mode="region" title="Region — drag over the app to screenshot" aria-label="Region mode">⬚</button>
        <button class="nh-mode" id="nh-mode-element" type="button" data-mode="element" title="Element — hover to outline, click to pick a component" aria-label="Element mode">◎</button>
        <button class="nh-mode" id="nh-mode-edit" type="button" data-mode="edit" title="Edit text — click a text element to edit it inline (Enter to save, Esc to cancel)" aria-label="Edit text mode">✎</button>
      </span>
      <span class="nh-sess">${sessionText}</span>
    </div>
    <div id="nh-transcript"></div>
    <div class="nh-marks" id="nh-marks"></div>
    <div class="nh-compose">
      <textarea id="nh-input" placeholder="Describe a change…  Enter to queue · ⌘↵ to send · Shift↵ newline"></textarea>
      <div class="nh-row">
        <button class="nh-btn nh-send" id="nh-send-btn" type="button">Send to agent</button>
        <button class="nh-btn nh-stop" id="nh-stop-btn" type="button" title="Interrupt the current turn" disabled>Stop</button>
      </div>
      <div class="nh-status" id="nh-status"></div>
    </div>
  </aside>
  <script src="${BUILD_JS_PATH}?${q}" data-nitpicker-harness="build"></script>
</body>
</html>`;
}

/** Minimal HTML-text escaping for values interpolated into the shell page (the session id). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
 *     it over X-Frame-Options), widen `script-src`/`connect-src`/`default-src` with the sidecar origin +
 *     `'unsafe-inline'`/`blob:`/`data:`, and add `'unsafe-inline'` to `style-src` so the overlay script
 *     runs, can POST feedback, and its shadow-DOM inline styles apply.
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
