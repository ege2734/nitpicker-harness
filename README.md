# nitpicker-harness

**Point it at a running web app and get the full [nitpicker](https://github.com/ege2734/nitpicker)
feedback overlay — with zero nitpicker code in the target's repo.**

nitpicker-harness is a standalone **same-origin reverse proxy**. It fronts a target dev server under its
own origin and rewrites the streamed HTML on the fly to inject `@nitpicker/core`. Because the page then
runs *same-origin* with the overlay, every nitpicker feature works unmodified:

- 🖼️ **Region screenshots** — drag a box; the app's live DOM is rasterized (html2canvas) with a red box
  burned in and everything else dimmed.
- 🎯 **Element pick** — click a node; get its React **component** name (runtime fiber walk, no build
  step), a stable CSS **selector**, testid, text, role, rect, and route.
- 💬 **Chat / queue → sidecar** — batch feedback and `Send to agent`; the agent long-polls it off a
  local sidecar.

All of it with **zero source edits, no layout change, and no `next.config` touch** in the target. The
harness reuses nitpicker's `core/`, `server/`, and `cli/` verbatim (vendored under `vendor/nitpicker/`);
the only new code is the proxy + injection glue and the overlay bundler.

> **Why a proxy and not an iframe?** The browser's Same-Origin Policy blocks a page from reading a
> cross-origin iframe's DOM — which is exactly what html2canvas, the selector builder, and the fiber
> walk need. Serving the target under the harness's own origin makes the frame same-origin, so those
> features work.

## Quickstart

```bash
# install deps (first time)
npm install

# your app's dev server is already running, e.g. on http://localhost:3000
npm run start -- --target http://localhost:3000
#   or, once published:  npx nitpicker-harness --target http://localhost:3000
```

It prints a harness URL (default `http://127.0.0.1:4000`) and starts its own sidecar. Open that URL,
mark up your app with the bottom-center dock, hit **Send to agent**, then drain the feedback:

```bash
npm run poll -- --session nitpicker
#   or:  npx nitpicker-harness poll --session nitpicker
```

`poll` prints a batch and exits (add `--watch` to keep receiving). Each item is a `region` (local PNG
path, red box burned in), an `element` (component/selector/text/route), or a `message`.

### Two modes: feedback proxy vs. builder shell

The harness fronts your app in two ways, advertised side by side in the ready banner:

- **Feedback-proxy mode** (the URL above) — the overlay is injected straight into your app's HTML, so the
  bottom-center dock rides on the live page. Full region + element + message capture. The fallback for
  apps you don't control.
- **Builder-shell mode** (`http://127.0.0.1:4000/__nitpicker-harness/shell`) — a shell page served on the
  harness origin that embeds your app in a same-origin `<iframe src="/">` and hosts the chat + queue in
  the **parent** window. Because the chrome lives outside the app frame, the queue **survives any
  in-iframe navigation** — SPA route change, hard reload, even a cross-origin excursion — with zero extra
  code. A mode toolbar drives the full interactive layer from the parent: **region** drag → screenshot
  and **element** pick → component/selector, both read out of the same-origin iframe and rendered over it.
  Both modes POST to the same sidecar, so `poll` drains either.

### Keep the agent driven

`poll` only delivers while the agent is actively running it — once a turn ends and the agent goes idle,
new marks sit in the sidecar and nothing wakes it. To make feedback **drive** the agent, install the
turn-end **Stop hook**: it parks on the sidecar at zero token cost and re-invokes the agent the instant a
mark lands (a blocking watcher + turn-end trigger). See [`SKILL.md`](./SKILL.md) →
"Keep the agent driven" for the one-time `.claude/settings.json` snippet. The feedback queue is durable —
a mark queued while nothing is polling is never lost; it is delivered to the next poll.

### CLI

```
nitpicker-harness --target <url> [--port 4000] [--session nitpicker] [--sidecar-port 5178] [--no-sidecar]
nitpicker-harness poll --session <id> [--endpoint <url>] [--watch]
nitpicker-harness stop-hook --session <id> [--endpoint <url>] [--timeoutMs <n>]   # turn-end driver hook
nitpicker-harness pending --session <id> [--endpoint <url>]                       # cheap "is feedback queued?"
nitpicker-harness health [--endpoint <url>]
nitpicker-harness shutdown [--endpoint <url>]
```

## How it works

```
 browser ──▶  nitpicker-harness (:4000)  ──▶  target dev server (:3000)
                 │  rewrites text/html:  inject overlay <script>, rewrite absolute URLs,
                 │  strip X-Frame-Options, relax CSP (frame-ancestors/script-src/connect-src/style-src)
                 │  forwards the HMR WebSocket (hot-reload survives)
                 │  serves /__nitpicker-harness/overlay.js  (esbuild IIFE, html2canvas inlined)
                 │  serves /__nitpicker-harness/shell(.js)   (builder-shell page + parent-chrome bundle)
                 ▼
             sidecar (:5178)  ◀── overlay POSTs feedback ──   agent `poll` drains it
                   ▲                                            ▲
                   └── Stop-hook parks on /wait (0 tokens) ─────┘  wakes the agent the instant a mark lands
```

- **`src/proxy/`** — the reverse proxy. `inject.ts` is the pure HTML/header rewriting (unit-tested);
  `server.ts` wires it into an [`http-proxy`](https://github.com/http-party/node-http-proxy) instance
  for HTML injection, plus a hand-rolled raw-socket tunnel for the HMR WebSocket upgrade (http-proxy's
  own `ws` pass is off — see [`AGENTS.md`](./AGENTS.md)).
- **`src/overlay/`** — the browser entry that calls `Nitpicker.mount()` from the reused core, bundled by
  esbuild into a single self-contained IIFE served to the proxied page (config rides on the script
  URL's query string, so no inline script is needed).
- **`src/shell/`** — the builder-shell mode: `inject.ts:shellPage` renders the parent page (the app in a
  same-origin iframe + the chat/queue chrome), and `entry.ts` (bundled by esbuild, mirroring the overlay)
  is the parent-window chrome. It reuses the vendored `core/transport.ts` to POST the queue and drives the
  region/element engine primitives against the iframe via the reused `Env` seam (`geometry.ts` holds the
  single-offset coordinate math that keeps the highlight/red box over the frame).
- **`vendor/nitpicker/`** — nitpicker's `core/` (overlay, region, elements, redbox, transport), the
  React `resolveElement` glue, the `server/` sidecar, and the `cli/` poll/verify — copied in so this
  repo is self-contained (it becomes nitpicker's canonical home when nitpicker is archived).

## The one honest limit: `file:line:col` source

A proxy sees the dev server's already-compiled output, so it can't manufacture exact source locations
for an arbitrary app. **`component` + `selector` + `text` + `route` are the baseline** (and are enough
for an agent to grep to the code) — **apps without the stamp keep working, just without `file:line`.**
Exact `file:line:col` is an **owned-build-only opt-in**: wire the vendored dev-only source-stamp loader
(`vendor/nitpicker/next/`) into the target's `next.config` — one config block, no source edits. Once
wired, the picker prefers `source` and it rides both the builder-shell chat item and the drained `poll`
payload (e.g. `source: "app/pricing-card.tsx:9:5"`). The exact one-liner (Turbopack `turbopack.rules` +
webpack fallback, both gated on `NODE_ENV`) is in [SKILL.md](./SKILL.md#opt-in-exact-fileline-col-source-owned-build-only).
If you can add it, prefer the full [nitpicker install skill](https://github.com/ege2734/nitpicker),
which also brings prod-safety gates. The harness's sweet spot is still *no target changes at all*.

## Status: Phase 1 (localhost dev proxy) — done vs. deferred

**Done & verified** (against live Next.js 15 / webpack and Next.js 16 / Turbopack, React 19 dev apps):

- ✅ Reverse proxy fronts the dev server under the harness origin; app renders identically.
- ✅ Overlay injected into streamed HTML same-origin; dock appears.
- ✅ Region screenshot rasterizes the app DOM with the red box (verified PNG).
- ✅ Element pick returns component (`FeedbackCard`) + selector + text + route.
- ✅ Region + element + message batch drained by the `poll` CLI over the session-keyed sidecar.
- ✅ Feedback **drives** an idle agent: a turn-end Stop hook parks on the sidecar's non-draining `/wait`
  at zero token cost and re-invokes the agent the instant a mark lands (durable queue → never lost).
- ✅ HMR WebSocket forwarded (raw-socket tunnel; `Origin` stripped so Turbopack's dev-origin gate
  returns `101`) — editing the source hot-reloads the proxied page, overlay intact.
- ✅ `X-Frame-Options` stripped, CSP `frame-ancestors` dropped + `script-src`/`connect-src`/`style-src` relaxed.
- ✅ Builder-shell mode: parent-hosted chat + queue over a same-origin iframe; the queue survives SPA nav,
  hard reload, and a cross-origin excursion, and its batch drains via `poll`. The interactive layer runs
  from the parent too — region drag → screenshot and element pick → component/selector read out of the
  iframe and rendered over it (Phase 2).
- ✅ Owned-build `file:line:col` provenance (Phase 3): a one-line `next.config` opt-in (the vendored
  dev-only source-stamp loader) makes the picker surface `source` in the chat item **and** the drained
  `poll` payload; apps without it degrade gracefully to component + selector + text + route.

**Deferred (follow-ups, not blockers):**

- ⏭️ Exact `file:line:col` without any target change (fundamentally needs build cooperation — opt-in only).
- ⏭️ Hard auth flows / third-party IdP redirects; SameSite-cookie edge cases.
- ⏭️ Non-Next frameworks (Vite/React, Streamlit) — the proxy is framework-agnostic but only Next is
  verified so far.
- ⏭️ **Browser extension** (for deployed / non-owned sites) and the **platform layer** — explicitly out
  of Phase 1 scope.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest: proxy injection (tests/) + reused core (vendor/nitpicker/tests/)
```

See [`AGENTS.md`](./AGENTS.md) for repo-specific notes.

## License

MIT — see [LICENSE](./LICENSE). Reuses code from [nitpicker](https://github.com/ege2734/nitpicker) (MIT).
