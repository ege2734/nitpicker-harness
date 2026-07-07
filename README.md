# nitpicker-harness

[![CI](https://github.com/ege2734/nitpicker-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/ege2734/nitpicker-harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Point it at a running web app and get the full feedback overlay — with zero overlay code in the
target's repo.**

nitpicker-harness is a standalone **same-origin reverse proxy**. It fronts a target dev server under its
own origin and rewrites the streamed HTML on the fly to inject the overlay. Because the page then runs
*same-origin* with the overlay, every feature works unmodified:

- 🖼️ **Region screenshots** — drag a box; the app's live DOM is rasterized (html2canvas) with a red box
  burned in and everything else dimmed.
- 🎯 **Element pick** — click a node; get its React **component** name (runtime fiber walk, no build
  step), the exact **`source`** `file:line:col` (owned Next builds — wired in setup), a stable CSS
  **selector**, testid, text, role, rect, and route.
- 💬 **Chat / queue → sidecar** — batch feedback and `Send to agent`; the agent long-polls it off a
  local sidecar.

All of it with **zero source edits and no layout change** in the target. The proxy + injection glue, the
overlay engine, the sidecar, and the `poll` CLI all live in this repo (the browser engine and sidecar
under `vendor/nitpicker/`, wrapped by the proxy in `src/`).

> **Why a proxy and not an iframe?** The browser's Same-Origin Policy blocks a page from reading a
> cross-origin iframe's DOM — which is exactly what html2canvas, the selector builder, and the fiber
> walk need. Serving the target under the harness's own origin makes the frame same-origin, so those
> features work.

## Quickstart

```bash
# install deps (first time). `npm install` also builds dist/ (via the `prepare` script).
npm install

# your app's dev server is already running, e.g. on http://localhost:3000
npm run dev -- --target http://localhost:3000
#   as an installed dependency:  npx nitpicker-harness --target http://localhost:3000
```

> **Consuming it as a dependency?** The published/git-installed package runs **compiled JS from `dist/`**
> with plain `node` — no `tsx`, no build step at runtime. Installing builds `dist/` (`prepare`/`prepack`),
> so the `nitpicker-harness` CLI and the library (`import { startEmbeddedBuilder } from "nitpicker-harness"`)
> work in a clean, no-dev-deps install. In THIS repo, `npm run dev` runs the TS source under tsx for a
> fast edit loop (`start`/`harness`/`poll` are aliases); `npm run build` produces `dist/`; and
> `npm run verify-pack` proves a packed, production-installed tarball is runnable. Rebuild (`npm run build`)
> after editing any browser entry or the vendored core before packing/publishing.

It prints a harness URL (default `http://127.0.0.1:4000`) and starts its own sidecar. Open that URL,
mark up your app with the bottom-center dock, hit **Send to agent**, then drain the feedback:

```bash
npm run poll -- --session nitpicker
#   or:  npx nitpicker-harness poll --session nitpicker
```

`poll` prints a batch and exits (add `--watch` to keep receiving). Each item is a `region` (local PNG
path, red box burned in), an `element` (component/selector/text/route, plus `source` file:line:col on an
owned Next build), or a `message`.

### Two modes: feedback proxy vs. builder shell

The harness fronts your app in two ways, advertised side by side in the ready banner:

- **Feedback-proxy mode** (the URL above) — the overlay is injected straight into your app's HTML, so the
  bottom-center dock rides on the live page. Full region + element + message capture. The fallback for
  apps you don't control.
- **Builder-shell mode** (`http://127.0.0.1:4000/__nitpicker-harness/shell`) — a shell page served on the
  harness origin that embeds your app in a same-origin `<iframe src="/">` and hosts the chat + queue in
  the **parent** window. Because the chrome lives outside the app frame, the queue **survives any
  in-iframe navigation** — SPA route change, hard reload, even a cross-origin excursion — with zero extra
  code. A mode toolbar drives the full interactive layer from the parent: **region** drag → screenshot,
  **element** pick → component/selector, and **edit** → inline click-to-edit text (Enter saves, Esc
  cancels), all read out of the same-origin iframe and rendered over it. Both modes POST to the same
  sidecar, so `poll` drains either.

### Embedded-agent mode — the side pane *is* the agent

Point the harness at an app **directory** instead of a URL and it owns the whole loop: it starts the
app's dev server, proxies it as above, and puts a **live agent you build with** in the side pane — no
external `poll` drain. Marks you make on the live preview become chips; on the turn boundary they're
formatted into a prompt for the agent, whose edits land in real source files and hot-reload the preview
through the proxy.

```bash
npm run dev -- ./path/to/app                # own the dev server + a live agent pane (builder URL)
npm run dev -- ./path/to/app --no-agent     # own the dev server, classic sidecar/poll sink
```

The dev command is auto-detected (`next dev` / `vite` / `react-scripts start` / `scripts.dev`); pass
`--dev-cmd "<cmd>"` to override — it **must** bind the injected `$PORT`
(e.g. `--dev-cmd "uvicorn app:app --reload --port $PORT"`), or pass `--target-port` matching the port it
binds, else readiness detection times out. An explicit `--target <url>` always wins, so the classic modes
above are untouched. The reference agent backend (`--agent claude`) uses the Claude Agent SDK in-process
(an optional dependency) with a `claude-cli` spawn fallback. Embedded mode is also exposed as a library —
`startEmbeddedBuilder()` from `src/index.ts`, the surface the platform layer drives; see
[`AGENTS.md`](./AGENTS.md).

**Builder-agent persona.** Every embedded session runs the **Loom builder agent** system prompt by default
(`LOOM_BUILDER_SYSTEM_PROMPT`, exported from `src/index.ts`): a friendly, minimal-scope engineer that knows
the Loom stack (Next.js + React + TypeScript, the `@loom/ds` design system, a FastAPI backend, Loom Plugins)
and the harness's own affordances (marks-as-context anchored on `file:line:col`, a live preview that HMRs on
every edit). Override it per session with `--system-prompt <file>`, the `systemContext` option on
`startEmbeddedBuilder`, or the `NITPICKER_HARNESS_SYSTEM_PROMPT` env var — an explicit value wins over the
env var, which wins over the default. Loom's own in-app builder consumes the identical persona by importing
the export (or simply by not overriding `systemContext`, since the default already applies).

### Keep the agent driven

`poll` only delivers while the agent is actively running it — once a turn ends and the agent goes idle,
new marks sit in the sidecar and nothing wakes it. To make feedback **drive** the agent, install the
turn-end **Stop hook**: it parks on the sidecar at zero token cost and re-invokes the agent the instant a
mark lands (a blocking watcher + turn-end trigger). See [`SKILL.md`](./SKILL.md) →
"Keep the agent driven" for the one-time `.claude/settings.json` snippet. The feedback queue is durable —
a mark queued while nothing is polling is never lost; it is delivered to the next poll.

### CLI

```
nitpicker-harness <path-to-app> [--dev-cmd "<cmd>"] [--target-port <n>] [--port 4000] [--session nitpicker] [--agent claude|claude-cli] [--no-agent] [--system-prompt <file>]
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
- **`src/overlay/`** — the browser entry that mounts the overlay engine, bundled by esbuild into a single
  self-contained IIFE served to the proxied page (config rides on the script URL's query string, so no
  inline script is needed).
- **`src/shell/`** — the builder-shell mode: `inject.ts:shellPage` renders the parent page (the app in a
  same-origin iframe + the chat/queue chrome), and `entry.ts` (bundled by esbuild, mirroring the overlay)
  is the parent-window chrome. It reuses the vendored `core/transport.ts` to POST the queue and drives the
  region/element engine primitives against the iframe via the reused `Env` seam (`geometry.ts` holds the
  single-offset coordinate math that keeps the highlight/red box over the frame).
- **`vendor/nitpicker/`** — the overlay engine (`core/`: overlay, region, elements, redbox, transport),
  the React `resolveElement` glue, the `server/` sidecar, the `cli/` poll/verify, and the `next/`
  dev-only source-stamp loader — the browser + sidecar half of the harness, kept here so the repo is
  self-contained.

## `file:line:col` source location

On an **owned Next build**, element pick reports the exact `file:line:col` of the clicked node — it rides
both the builder-shell chat item and the drained `poll` payload (e.g.
`source: "app/pricing-card.tsx:11:7"`). Setup wires it on as a standard step: add `@babel/core` to the
target, copy `vendor/nitpicker/next/` in, and wrap the target's `next.config` export with
`withNitpickerSource(...)` — one import, one wrapped line, composes with any existing config, dev-only
(off in `next build`). The full recipe is in [SKILL.md](./SKILL.md#turn-on-filelinecol-source-default-setup-step).

The stamp **detects-and-skips cleanly**: an app you don't own, or one that isn't Next/Turbopack, needs
none of it and still returns `component` + `selector` + `text` + `route` on every pick — enough for an
agent to grep straight to the code.

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
- ✅ Owned-build `file:line:col` provenance (Phase 3): a default setup step (the `withNitpickerSource`
  wrapper around the target's `next.config`, dev-only) makes the picker surface `source` in the chat item
  **and** the drained `poll` payload; apps that skip it degrade cleanly to component + selector + text + route.
- ✅ Inline click-to-edit text (Phase 4): an "edit" mode makes the picked node `contenteditable` in the
  iframe; on save the before/after text rides a source-keyed `text-edit` mark that `poll` prints as
  `source` → `old → new` for the agent to patch. Without a source stamp it degrades to selector + text.

**Deferred (follow-ups, not blockers):**

- ⏭️ Hard auth flows / third-party IdP redirects; SameSite-cookie edge cases.
- ⏭️ Non-Next frameworks (Vite/React, Streamlit) — the proxy is framework-agnostic but only Next is
  verified so far.
- ⏭️ **Browser extension** (for deployed / non-owned sites) and the **platform layer** — explicitly out
  of Phase 1 scope.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest: proxy injection (tests/) + overlay engine (vendor/nitpicker/tests/)
npm run build       # esbuild → dist/ + tsc → dist/types (what consumers run; auto-run by prepare/prepack)
npm run verify-pack # CLEAN-INSTALL regression: pack → prod install → run bin + embedded smoke
```

See [`AGENTS.md`](./AGENTS.md) for repo-specific notes.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and conventions, and the
[Code of Conduct](./CODE_OF_CONDUCT.md). Please report security issues privately, not as public issues —
see [SECURITY.md](./SECURITY.md). Notable changes are tracked in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT — see [LICENSE](./LICENSE).
