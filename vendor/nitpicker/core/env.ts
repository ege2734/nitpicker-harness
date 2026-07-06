// @nitpicker/core — the DOM "environment" seam. HARNESS-LOCAL DELTA (not upstream; see
// vendor/nitpicker/README.md → "Local modifications").
//
// The overlay engine (overlay.ts + region.ts) was written against the AMBIENT `document`/`window`
// globals: it reads element rects, attaches picker listeners, rasterizes with html2canvas, and reads
// scroll/viewport state — all off the one document it lives in. That is correct for the injected mode
// (the overlay runs same-origin INSIDE the target page, so ambient === the app). The nitpicker-harness
// *builder shell* (src/shell) needs the SAME engine to read a DIFFERENT document: the same-origin
// `<iframe>`'s `contentDocument`/`contentWindow`, while the highlight/red-box UI renders in the PARENT
// shell. To let one engine serve both, every ambient `document.`/`window.` reference is routed through
// this `Env` handle instead. Injected mode passes the ambient env (identical behavior); the shell passes
// the iframe's env.
export interface Env {
  doc: Document;
  win: Window;
}

/** The ambient browser env (the document/window this script itself runs in). Kept as a function — never a
 *  module-level const — so it is evaluated lazily at call time (a browser context), not at import time (a
 *  bundler/node/jsdom-collect context where `document`/`window` may be absent). This is the default env for
 *  every parameterized engine function, so unpassed calls behave exactly as they did pre-seam. */
export function ambientEnv(): Env {
  return { doc: document, win: window };
}
