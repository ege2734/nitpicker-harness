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
- `src/cli.ts` + `bin/nitpicker-harness` — CLI; spawns the vendored sidecar and starts the proxy. Also
  exposes `stop-hook` (the turn-end driver) and `pending` (cheap queued-count signal).
- `src/hook.ts` — the **feedback driver**: a Claude-Code Stop-hook that parks on the sidecar's `/wait`
  (zero token cost) and, when a mark lands, emits `{"decision":"block","reason":…}` to re-invoke the
  agent to drain via `poll`. `decideStopHook` is a pure, injectable-transport core (unit-tested in
  `tests/driver.test.ts`); `httpTransport` is the live wiring. See "The feedback driver" below.
- `vendor/nitpicker/` — code copied verbatim from nitpicker (see `vendor/nitpicker/README.md`), last
  synced from nitpicker `main` @ `a8d109b`. This repo is self-contained and must not depend back on the
  nitpicker repo. nitpicker is being archived, so this is the canonical home — do not upstream back.
- `docs/` — background research: `viability-report.md` (the same-origin-proxy design authority) and
  `competitive-landscape.md` (prior-art scan). `docs/README.md` indexes them.

## Sharp edges (learned the hard way)

- **esbuild breaks under vitest's `jsdom` environment** ("TextEncoder … not Uint8Array"). Any test that
  calls `buildOverlay()` (i.e. `tests/proxy.test.ts`) must start with `// @vitest-environment node`.
  The default env stays jsdom for the DOM-facing core units.
- **React 19 `_debugOwner` is owner-info, not a fiber.** The component name lives on `.name` (no
  `.type`). `vendor/nitpicker/react/react-source.ts` was patched to read both shapes; without it
  element-pick returns no `component` on React 19. This is a **harness-local delta upstream lacks** —
  when re-syncing `vendor/nitpicker/`, do NOT blind-copy `react-source.ts`/`react-source.test.ts`;
  preserve this patch (the rest of both files tracks upstream verbatim).
- **`vendor/nitpicker/server/index.ts` + `store.ts` carry a harness-local delta:** the `GET /pending`
  (cheap count) and `GET /wait` (non-draining long-poll) endpoints the feedback driver needs, plus the
  per-session `drains` generation counter in `store.ts` (`drainCount`, bumped only on a real delivery)
  that both endpoints report. They are marked in-file; preserve them on re-sync (same rule as the
  `react-source.ts` patch). Draining stays exclusive to `/poll`, so these can never race away an item.
- **Overlay bundle is cached in-process** (`build.ts`). After editing the overlay or vendored core,
  **restart the harness** — a reload alone serves the stale cached bundle.
- **Sidecar port conflicts:** default 5178 is shared with any running nitpicker install. Use
  `--sidecar-port` (and matching `--endpoint`) to isolate; `--no-sidecar` to reuse an external one.
- To avoid gzip handling on the injection path, the proxy sends `accept-encoding: identity` upstream and
  resets `content-length`/`transfer-encoding`/`content-encoding` on the rewritten HTML.

## The feedback driver (idle agent → still gets driven)

`poll`/`poll --watch` only delivers while the agent is actively running it. So feedback that lands after
a turn ends would sit undriven. The driver closes that gap with the firstmate "blocking watcher +
turn-end trigger" shape:

- The sidecar queue is already **durable** (`store.drain` clears only on actual delivery), so a mark
  queued while nothing is polling is never lost — it waits for the next `/poll`. This invariant is the
  foundation; the endpoints below and the hook are additive.
- `GET /wait` is the OS-level event source: a non-draining long-poll that resolves the instant the queue
  is non-empty. The Stop-hook (`src/hook.ts`, `stop-hook` subcommand) parks on it at **zero token cost**.
- When a mark lands, the hook emits `{"decision":"block","reason":…}`; the agent's harness re-invokes the
  agent, which drains via `poll`. The hook **fails open** (never wedges a stop if the sidecar is down).
  Documented as the default install in `SKILL.md`.
- **Loop-safety is the drain-generation counter, not `stop_hook_active`.** The store bumps a per-session
  `drains` count only on a real delivery; `/pending` and `/wait` both report it. The hook persists the
  generation it last drove at (file-backed under `os.tmpdir()`, keyed by endpoint+session) and re-drives
  iff a drain has happened since (`drains` advanced) — so a batch that lands *after* the agent drained
  mid-turn still gets driven, while a queue the agent simply ignored (generation unchanged) does not spin.
  This closes the mid-turn stranding gap a bare `pending > 0` guard left open.
- Install is a `Stop` hook in the target harness's `.claude/settings.json` with a large `timeout` (the
  wall-clock ceiling the hook stays parked; Claude-Code hooks are hard-killed at `timeout`, no heartbeat
  extension). On timeout the agent idles and the durable queue + next turn re-arm cover the gap.

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
