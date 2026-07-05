# Project agent memory

Project-intrinsic knowledge for nitpicker-harness — the standalone same-origin **proxy** that fronts a
target dev server and injects the nitpicker feedback overlay with **zero code in the target repo**.

## What this is (and the load-bearing idea)

The overlay must run **same-origin** with the target — html2canvas region capture, the CSS-selector
builder, and the React fiber walk are all synchronous DOM reads that the Same-Origin Policy blocks
across a cross-origin iframe. So the harness **proxies** the target under its own origin and injects the
overlay into the streamed HTML. Design authority: the viability report (task spec §3a / §6 Phase 1).

## Layout

- `src/proxy/inject.ts` — **pure** HTML/header rewriting (injection, absolute-URL rewrite, CSP/framing
  relaxation). Unit-tested in `tests/inject.test.ts`. Keep it side-effect-free.
- `src/proxy/server.ts` — wires `inject.ts` into an `http-proxy` instance: streaming HTML injection
  (`selfHandleResponse`), `X-Frame-Options`/CSP relaxation, absolute-URL rewrite, and **WebSocket
  upgrade forwarding** (HMR). Assets/HMR pass through; only `text/html` is buffered+rewritten.
- `src/overlay/entry.ts` + `build.ts` — the browser overlay entry (calls the reused `Nitpicker.mount()`)
  bundled by **esbuild** into one IIFE with html2canvas inlined, served at
  `/__nitpicker-harness/overlay.js`. Config (session/endpoint) rides on the script URL's query string —
  no inline script, so a strict `script-src 'self'` still runs it.
- `src/cli.ts` + `bin/nitpicker-harness` — CLI; spawns the vendored sidecar and starts the proxy.
- `vendor/nitpicker/` — code copied verbatim from nitpicker (see `vendor/nitpicker/README.md`). This
  repo is self-contained and must not depend back on the nitpicker repo.

## Sharp edges (learned the hard way)

- **esbuild breaks under vitest's `jsdom` environment** ("TextEncoder … not Uint8Array"). Any test that
  calls `buildOverlay()` (i.e. `tests/proxy.test.ts`) must start with `// @vitest-environment node`.
  The default env stays jsdom for the DOM-facing core units.
- **React 19 `_debugOwner` is owner-info, not a fiber.** The component name lives on `.name` (no
  `.type`). `vendor/nitpicker/react/react-source.ts` was patched to read both shapes; without it
  element-pick returns no `component` on React 19. Upstream this to nitpicker.
- **Overlay bundle is cached in-process** (`build.ts`). After editing the overlay or vendored core,
  **restart the harness** — a reload alone serves the stale cached bundle.
- **Sidecar port conflicts:** default 5178 is shared with any running nitpicker install. Use
  `--sidecar-port` (and matching `--endpoint`) to isolate; `--no-sidecar` to reuse an external one.
- To avoid gzip handling on the injection path, the proxy sends `accept-encoding: identity` upstream and
  resets `content-length`/`transfer-encoding`/`content-encoding` on the rewritten HTML.

## Commands

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest: tests/** (proxy) + vendor/nitpicker/tests/** (reused core)
npm run start -- --target http://localhost:3000   # run the harness
```

## Verify a change end-to-end

Scaffold or point at a Next dev app, run the harness at it, open the harness URL, and confirm: dock
appears, a Region drag yields a red-boxed PNG, Element pick returns `component` + `selector`, and a
`Send to agent` batch is drained by `nitpicker-harness poll --session <id>`. (A throwaway Next app under
a gitignored `/verify-app/` or the scratchpad is the standard fixture.)

## Scope

Phase 1 = localhost dev proxy, Next.js reference target. Out of scope: browser extension, platform
layer. `file:line:col` source is opt-in only (needs the target's bundler). See README "done vs deferred".
