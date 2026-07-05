// nitpicker-harness — the browser entry that mounts the reused @nitpicker/core overlay inside a
// proxied target page. This file is bundled by esbuild (src/overlay/build.ts) into a single IIFE with
// html2canvas inlined, then served at `/__nitpicker-harness/overlay.js` and injected into every proxied
// HTML response. Because the harness serves the target under its OWN origin, this script runs
// same-origin with the app → the overlay has full synchronous DOM access (region rasterize, selector
// build, React fiber walk) exactly as if it had been installed into the target repo.
//
// Config (session + sidecar endpoint) is read from the query string of this script's own <script src>,
// so no inline <script> is needed — a page with a strict `script-src 'self'` still runs the overlay.
import { Nitpicker } from "../../vendor/nitpicker/core/index";
import { resolveReactElement } from "../../vendor/nitpicker/react/react-source";

/** Read `session`/`endpoint` off the query string of the currently-executing <script> tag. */
function readConfig(): { session: string; endpoint: string } {
  const fallback = { session: "nitpicker", endpoint: "http://127.0.0.1:5178" };
  try {
    const cur = document.currentScript as HTMLScriptElement | null;
    const src = cur?.src;
    if (!src) return fallback;
    const params = new URL(src).searchParams;
    return {
      session: params.get("session") || fallback.session,
      endpoint: params.get("endpoint") || fallback.endpoint,
    };
  } catch {
    return fallback;
  }
}

function mount(): void {
  const { session, endpoint } = readConfig();
  Nitpicker.mount({
    session,
    endpoint,
    // The React/Next glue enriches a picked element with the component name (fiber walk, no build step
    // needed) and — when the opt-in source-stamp transform is wired into the target's bundler — the
    // `file:line:col` source. Component/selector/text/route work with zero target cooperation.
    resolveElement: resolveReactElement,
  });
  // Small breadcrumb so a developer (or agent) can confirm the harness injected successfully.
  console.info("[nitpicker-harness] overlay mounted — dock is bottom-center. session:", session);
}

// The overlay appends its shadow host to document.body, so wait for the body to exist. The injector
// places this script just before </body>, but guard anyway for head-injected or racing cases.
if (document.body) mount();
else document.addEventListener("DOMContentLoaded", mount, { once: true });
