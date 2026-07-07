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
- `src/shell/entry.ts` + `build.ts` — the **builder-shell** mode (viability report §6 / Phase 1), a
  SECOND mode that is additive, not a replacement. The shell page (`inject.ts:shellPage`, served at
  `/__nitpicker-harness/shell`) embeds the proxied app in a same-origin `<iframe src="/">` and hosts the
  chat + queue in the **PARENT** window (bundle served at `/__nitpicker-harness/shell.js`). Because the
  chrome lives in the parent heap, it survives ANY navigation the iframe does — SPA route change, hard
  reload, even a cross-origin excursion — with **zero** extra work; persistence is structural (this is
  why the `nh-persist-nav` localStorage idea was dropped). Reuses `vendor/nitpicker/core/transport.ts` +
  `types.ts` for the sidecar POST. **Phase 2 (landed)** added the interactive layer: element pick
  (hover-outline + click → `baseDescriptor` + `resolveReactElement`, incl. component name) and region +
  element screenshots (html2canvas run in the PARENT against the iframe content). All of it is driven from
  the parent reading into the iframe via the reused engine's `Env` seam (below). `src/shell/geometry.ts`
  holds the §5 single-offset coordinate math (pure, unit-tested). The injected `overlay.js` "feedback
  proxy" mode stays as the fallback for apps we don't control. **Phase 3 (landed)** made `file:line:col`
  source provenance work on any owned Next build: the shell chat item surfaces `source` as its own
  `nh-item-source` chip and it already rides the wire (`serializeItem` carries the whole `element`, so no
  transport change was needed). Apps without the build stamp degrade to `component + selector + text +
  route` with no error. Wiring is now a **standard setup step, not an opt-in** — `SKILL.md` has the agent
  wire it by default on owned Next apps via `vendor/nitpicker/next/with-nitpicker-source.cjs`, a one-line
  `withNitpickerSource(nextConfig)` wrapper that composes the dev-only source-stamp loader into
  `turbopack.rules` + a webpack fallback (spreads, never clobbers; gated on `NODE_ENV`, so `next build` is
  untouched; loader path resolved from the wrapper's own `__dirname`, so it's cwd-independent). **The
  target app must have `@babel/core` installed** — the loader dynamic-imports it to transform JSX; without
  it the loader logs `source-stamp skipped … Cannot find package '@babel/core'` and passes the file
  through unstamped (clean degradation, but no `source`). The wrapper + loader are regression-tested in
  `tests/source-stamp.test.ts`; end-to-end verified through the proxy under Next 16 / Turbopack. **No
  user-facing doc frames `file:line` as a limitation/drawback** — present element pick as returning a
  source location; keep degradation notes internal. **Phase 4 (landed — the finale)** added
  **inline click-to-edit text**: a 4th "edit" mode reuses the Phase-2 pick surface, but the click terminal
  makes the picked iframe node `contenteditable` (the parent sets it on the same-origin node), and on
  blur/Enter captures `{ oldText, newText }` + the Phase-3 `element` descriptor into a new `"text-edit"`
  `QueueItem.kind`. Enter commits, Escape restores the node's original `innerHTML` and discards. The mark
  degrades gracefully without a source stamp (selector + text only). `poll` renders it as `source` →
  `old → new` → component → selector. The `text-edit` kind is a harness-local delta across
  `core/types.ts` + `server/store.ts` (schema-light passthrough) + `cli/poll.ts` (see
  `vendor/nitpicker/README.md`); round-trip is unit-tested in `vendor/nitpicker/tests/sidecar.test.ts`.
  v1 limitation: the source stamp is per host element, so an element with mixed children maps the edit to
  the element, not the exact text node.
- `src/cli.ts` + `bin/nitpicker-harness` — CLI; spawns the vendored sidecar and starts the proxy. Also
  exposes `stop-hook` (the turn-end driver) and `pending` (cheap queued-count signal). A **bare positional
  path** (`nitpicker-harness <path-to-app>`, or `--app`) selects **embedded-agent mode** (below) via
  `serveEmbedded`; the existing `--target <url>` path is unchanged and mutually exclusive (an explicit
  `--target` always wins).
- **Embedded-agent mode (W1, additive)** — `nitpicker-harness <path-to-app>` makes the side pane a **live
  agent you build with** instead of an external `poll`-drained queue. It is strictly additive: the
  feedback-proxy / builder-shell / sidecar / `poll` / stop-hook paths are byte-for-byte unchanged (pocket-
  watcher + membership-management depend on them). Design authority: `data/hz-agent-h2/report.md` §7 +
  loom-decision **D7** (Claude Agent SDK in-process reference backend + SSE gateway; CLI-spawn fallback;
  reuse the `QueueItem`/`WireItem` mark schema verbatim). The new modules:
  - `src/index.ts` — the **library entrypoint** `startEmbeddedBuilder(opts)` Loom drives per app + all the
    interface re-exports. It composes: `LocalAppRuntime` (owns the dev server) → reuse the sidecar for its
    `/blob` image store → `makeBackend()` → `AgentGateway` → `startHarness({ mountExtra, builderPane })`.
    Returns `{ url, builderUrl, shellUrl, targetUrl, session?, runtime, gateway?, close() }`. `close()` is
    the idle→free teardown (dev server + agent + sidecar + proxy). `package.json` `exports`/`main` point at
    the compiled `dist/index.js` (built from this source; see the "Packaging" section below).
  - `src/app/runtime.ts` — `AppRuntime` interface + `LocalAppRuntime` (v0 process-group owner, D6) +
    `detectDevCommand` (next→`next dev`, vite→`vite`, react-scripts→`react-scripts start`, else
    `scripts.dev`; explicit `--dev-cmd` wins, covers `uvicorn app:app --reload --port $PORT`). Spawns
    `detached` (its own process group) and injects `PORT`, then polls readiness, surfacing
    `starting|ready|crashed|stopped`. An explicit `--dev-cmd` MUST bind the injected `$PORT` (or the caller
    passes `--target-port` matching the port it binds), else the readiness probe never finds the server.
    `stop()` signals the whole process group so an npm-forked grandchild dev server (`scripts.dev` path) is
    reaped and the port is freed. Names mirror `@loom/contracts` `AppRuntime`. NOTE
    the deliberate two-level naming: `AppRuntime` here is the **in-container dev-server** lifecycle; Loom's
    Python control-plane `Runtime` is the platform orchestrator — keep them distinct.
  - `src/agent/backend.ts` — vendor-agnostic `AgentBackend`/`AgentSession`/`AgentEvent`/`AgentInput`/
    `WireItem` (mirror `@loom/contracts/agent.ts` verbatim so Loom pins this repo) + `makeBackend(name)`
    registry. `src/agent/claude-backend.ts` — the reference backend: **in-process** over
    `@anthropic-ai/claude-agent-sdk` (dynamic-imported by a non-literal specifier so it stays an *optional*
    dep — declared under `optionalDependencies`, never statically required; unit tests never load it) with a
    `claude -p --output-format stream-json` **CLI-spawn fallback** (`makeBackend("claude-cli")`).
  - `src/agent/system-prompt.ts` — the **default builder-agent persona** `LOOM_BUILDER_SYSTEM_PROMPT` +
    `resolveSystemPrompt(explicit?, env?)`. This is the **canonical, single source of truth** for the
    embedded persona: BOTH the standalone `nitpicker-harness <app>` CLI AND Loom's own in-app builder run it
    (Loom imports the export from the package, or just doesn't override `systemContext` — the default already
    applies). Adapted from the captain's Lovable prompt (`data/loom-agent-persona/lovable-source-prompt.md`):
    Lovable branding + `lov-` tags stripped; stack retargeted Vite/Tailwind/shadcn/Supabase → Next.js +
    `@loom/ds` + FastAPI backend + Loom Plugins; affordances rewritten to the harness's real surface (marks
    anchored on `file:line:col`, live-preview HMR). **Precedence** (`resolveSystemPrompt`, highest first):
    explicit caller value (`startEmbeddedBuilder`'s `systemContext` / the CLI's `--system-prompt <file>`) →
    the `NITPICKER_HARNESS_SYSTEM_PROMPT` env var → the built-in default. Resolved ONCE in
    `startEmbeddedBuilder` so the eager primary session and the gateway's lazy sessions share one persona.
    Blank/whitespace overrides are treated as absent (never silently disable the persona). Guarded by
    `tests/system-prompt.test.ts` (precedence + no residual Lovable/Vite/Supabase + the Loom stack markers).
  - `src/agent/format.ts` — **pure** marks→prompt formatting (element→source line, region→image-path line,
    text-edit→"change X to Y", message→note). `src/agent/gateway.ts` — the **SSE Agent Gateway** mounted on
    the existing server via `startHarness`'s new `mountExtra` hook. Routes under `/__nitpicker-harness/agent`:
    `POST /message`, `GET /stream` (SSE, `Last-Event-ID` resumable), `POST /interrupt`, `GET /history`.
    Server-side **authoritative** transcript + event log keyed by `sessionId`. Auth is a parameter
    (`GatewayAuth`: `openAuth()` local default, `bearerAuth(token)` for Loom) — token via header/cookie,
    **never** the query string.
  - `src/shell/interaction.ts` — the reusable `InteractionLayer` **extracted verbatim** from `ShellChrome`
    (mode toolbar, picker, region drag→capture, inline edit, geometry, `Env`→`QueueItem`). It is
    sink-agnostic (`InteractionSink`): `ShellChrome` keeps the sidecar `Transport` sink; `BuilderChrome`
    (`src/builder/entry.ts`) swaps in the gateway client (`src/builder/client.ts`) + a streaming transcript.
    `src/builder/{entry,build}.ts` + `inject.ts:builderPage()` serve the new `/__nitpicker-harness/build[.js]`
    pane (sibling of the shell). Extraction is behavior-preserving — guarded by `tests/interaction.test.ts`
    + the unchanged `tests/shell-geometry.test.ts` / vendor `env-seam.test.ts`. **`InteractionSink.onMark`
    takes an optional `anchor?: ParentBox`** — the mark's selection rect in PARENT-viewport coords (region
    drag box / element+edit highlight box), so a host can place a per-mark popup near the selection. The
    layer sets status BEFORE calling `onMark` on all three producers (element/region/text-edit) so the host's
    `onMark` has the final word on the status line; the shell just clears it (unchanged), the builder uses it.
  - **Per-mark annotate popup (builder-pane only) — `src/builder/annotate.ts`.** The extracted
    `InteractionLayer` originally had `BuilderChrome.onMark` **silently** auto-attach every mark to the
    composer. That dropped the classic feedback-overlay confirm step, so the user never got to annotate or
    reject a mark. `BuilderChrome.onMark` now opens an `AnnotationPopup` near the mark's `anchor`: a note
    input + **Queue** (confirm → `item.text = note`, push to `pendingMarks`, render the chip) / **Cancel**
    (Esc or button → **discard**, never queued). Enter confirms, empty note is allowed (optional). It's a
    single-instance parent-window popup with self-contained inline styles (dark builder chrome), so it needs
    no server-rendered markup. **The classic shell keeps its silent auto-queue** (`ShellChrome.onMark` just
    pushes) — the popup is builder-only. Region marks show the popup while the html2canvas raster runs in the
    background; discarding a region just orphans the in-flight capture (never pushed → the late
    `removeMark(id)` on a capture failure is a harmless no-op). Guarded by `tests/annotate.test.ts`
    (confirm-attaches / cancel-discards / Esc / single-instance).
  - **Persist-selection-until-commit (`InteractionLayer.showSelection`/`clearSelection`).** Ported from the
    classic overlay's dim-bands + red-outline "persist until commit": while the annotate popup is open the
    red selection box + a **dimmed backdrop over the preview** stay visible so the user sees exactly what they
    framed. Implemented as a `#nh-selection` container clipped to the iframe rect (`overflow:hidden`) holding
    a red box whose `box-shadow:0 0 0 9999px rgba(0,0,0,.45)` dims everything OUTSIDE it — a single-element
    "dim with a hole", clipped so it never covers the chat rail; it sits just below the popup. `BuilderChrome`
    drives it: `onMark` calls `showSelection(anchor)` (after `annotate.open`, which resolves any prior popup →
    its `onCancel` → `clearSelection`); confirm/cancel call `clearSelection`. A fresh region drag also clears
    it. The shell never calls these (it queues on release). Guarded by `tests/interaction.test.ts`.
  - **Ported queued-mark UX at parity — `src/builder/queue.ts` (`buildQueueItem`).** The builder shipped a
    minimal chip bar; this ports the classic prior art: the per-kind row (region/element/text-edit + source
    chip + note preview + remove) mirrors `ShellChrome.render()`, and the **expandable detail** — click a row
    to reveal the **red-boxed region SCREENSHOT** (full-res `_blob` object URL → `_thumb` data URL →
    "capturing…/failed" placeholder) or the element/text-edit descriptor lines (component/source/selector/
    testid/tag), plus a live-editable note — is ported from the overlay item modal (`openItemModal` +
    `fillRegionBody`). `BuilderChrome.renderMarks` renders a scrollable column list with a count header,
    tracks a single `expandedId`, and revokes region object URLs before each re-render. **It stays on the
    live-SSE-agent sink** — marks + notes attach to the agent turn over the Agent Gateway; only the
    queue/annotation UI was ported, NOT the sidecar/poll destination. Guarded by `tests/queue.test.ts`.
    Three follow-ons layer on this: (a) **region screenshot lightbox** (`src/builder/lightbox.ts`) — clicking
    an expanded region preview opens the FULL-res `_blob` (→ `_thumb` fallback) full-screen over a dim
    backdrop; Esc / backdrop-click closes and the full-size object URL is revoked (the rail preview itself
    uses the leak-free `_thumb`); single-instance; `tests/lightbox.test.ts`. (b) **Enter-to-save on a queued
    note** — the expanded item's note textarea commits on Enter (→ `onNoteChange` + collapse), Esc cancels
    (prior note kept — edits are NOT live-applied), Shift+Enter newlines; mirrors the classic modal's Save.
    (c) **Composer queueing model** (`src/builder/compose.ts`, pure) — `classifyComposerKey`: **Enter** stages
    the typed text as a `"message"` `QueueItem` into the SAME queue (no send), **Cmd/Ctrl+Enter** flushes the
    whole queue as one turn, **Shift+Enter** newlines; the Send button flushes. `partitionQueue` is the
    grouping decision (the steer's open judgment call): queued `message` items join in order into the turn's
    typed `text`, non-message marks ride as `marks` — exactly the shape `formatTurn` composes (text leads,
    marks as context). Flush first folds any un-staged composer text in, so a single quick message still sends
    in one ⌘↵ gesture. `tests/compose.test.ts`. The classic **shell** composer (Enter=queue via `queueMessage`)
    is unchanged.
  - **Sent-turn history + markdown agent replies (builder pane).** (1) **Sent-turn history** — flush no
    longer fires-and-clears: `BuilderChrome.appendSentTurn` records the flushed batch as an expandable entry
    in the transcript (above the streamed reply). `buildSentTurn` (in `queue.ts`) renders a collapsed summary
    (lead text + kind/count badge, e.g. "2 marks · 1 message") that expands to each item as a **read-only**
    queued item (`buildQueueItem(..., { readonly: true })` — no remove, no note textarea; note shown
    statically), including the red-boxed region screenshot with **click-to-lightbox**. The batch's item
    objects are retained (with `_thumb`/`_blob`) so screenshots render later; memory is bounded by
    `pruneSentBlobs` (full-res `_blob` kept for the most recent `FULLRES_TURNS`=10 turns, older drop it and
    fall back to the always-kept `_thumb`). No object URLs are created for previews (thumbs are data URLs), so
    nothing leaks on flush — the lightbox revokes its own on close. `tests/queue.test.ts` (`buildSentTurn`).
    (2) **Markdown agent replies** (`src/builder/markdown.ts`) — assistant messages render as sanitized
    markdown into a `.nh-md` container instead of raw text. `renderMarkdownInto` builds DOM with
    createElement/textContent (never innerHTML) + scheme-checked links, so agent output can't inject HTML/XSS;
    it's STREAM-SAFE (re-parses the accumulated string per token, coalesced to one paint/frame via rAF;
    unterminated fences / half-typed `**bold` degrade gracefully) and dependency-light (no new deps). Emphasis
    is `*`-only (never `_`) so `file_line_col` paths aren't mangled, and a **soft** line break (single wrapped
    newline) renders as a SPACE, not `<br>` (else "wired.\nCSS" → "wired.CSS", dropping the inter-word space);
    a hard break (two trailing spaces / backslash) is still `<br>`. `.nh-md` styles live in `builderPage()`;
    `tests/markdown.test.ts`. User messages stay plain. Classic shell chat unchanged.
  - **Region-capture icon fonts (tofu-box fix) — the html2canvas cross-document trap.** Region screenshots
    rasterized self-hosted icon webfonts (e.g. `@loom/ds`'s Phosphor font) as tofu boxes (□) even though the
    live app was fine. html2canvas draws text with the **ambient** document's fonts, but the builder/shell
    path rasterizes a **different** document (the proxied iframe via the `Env` seam) — so the iframe's icon
    `@font-face` is absent from the drawing document. `await document.fonts.ready` is necessary but NOT
    sufficient (the font is loaded — in the WRONG document). `vendor/nitpicker/core/region.ts`
    `embedFontsForCapture` reads the source doc's `@font-face` rules, fetches the bytes (same-origin under the
    proxy), and `FontFace`-loads them into the drawing doc (`hostEl.ownerDocument`) before capturing. **Found +
    fixed via a real browser loop** (Playwright + a synthetic PUA icon font + an iframe repro) — see
    `tests/fixtures/icon-capture/`; DON'T iterate this blind on unit tests alone (a same-document unit test
    passes while the cross-document case tofus). Guarded by `vendor/nitpicker/tests/region-fontembed.test.ts`.
  - **Overlay-suppression is MODE-gated (no double UI):** the embedded builder pane drives element-pick /
    region / inline-edit from the PARENT against its iframe (the reused `InteractionLayer`/`Env` seam), so
    injecting the classic in-frame overlay dock+queue would be a redundant SECOND feedback UI over the same
    preview. `server.ts` therefore gates injection on the **mode**, not the request: `startHarness` computes
    `injectClassicOverlay = !opts.builderPane` once, and the `proxyRes` HTML path injects **only** when it's
    true. So in EMBEDDED/BUILDER mode (`builderPane` on) the classic overlay is **never** injected into any app
    page; in classic feedback-proxy / shell mode (`builderPane` off) it's injected exactly as before —
    byte-for-byte unchanged. The builder iframe loads a **plain** `src="/"` (no query flag). **Why mode-gating,
    not the earlier per-request query flag (#22):** the `?__nh_no_overlay=1` flag rode only the iframe's INITIAL
    `src`, so a target that 307-redirects `/`→`/dashboard` (e.g. the Loom shell) — or any SPA/full-page
    navigation — dropped the flag and the LANDED page got the overlay re-injected (the exact double-UI bug).
    Mode-gating doesn't depend on the request URL at all, so every app request through an embedded harness is
    suppressed, redirects and navigations included. The classic **shell** (`/shell`) still gets the in-frame
    overlay (it runs with `builderPane` off; preserved, not regressed). Guarded by `tests/inject.test.ts`
    (`builderPage` plain src) and `tests/proxy-embed.test.ts` (through the real proxy: embedded mode has no
    overlay `<script>` on a plain page NOR on a `/`→`/dashboard` redirect target; classic mode still injects on
    both).

  The **load-bearing reuse**: the agent edits real source files → the app's own HMR (already forwarded
  through the proxy) reloads the iframe. No preview-refresh channel is built; chat + live preview stay in
  lockstep for free. Tests: `tests/gateway.test.ts` (marks→prompt + SSE stream/resume + auth),
  `tests/runtime.test.ts` (dev-command detection + spawn/ready/stop), `tests/proxy-embed.test.ts` (pane +
  gateway mounted through the real proxy; classic paths still served).
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
- **Overlay AND shell bundles are cached in-process** (`overlay/build.ts`, `shell/build.ts`). After
  editing either browser entry or the vendored core, **restart the harness** — a reload alone serves the
  stale cached bundle.
- **Read `document.currentScript` config SYNCHRONOUSLY at module load, never in a deferred callback.**
  Both browser entries carry their session/endpoint on their `<script src>` query string. `currentScript`
  is only non-null while the script executes synchronously; a script injected at end-of-`<body>` runs
  while `document.readyState === "loading"`, so if you defer the read into a `DOMContentLoaded` handler it
  fires with `currentScript === null` and you **silently fall back to the default endpoint** (a POST to a
  dead `:5178` → "Failed to fetch"). `src/shell/entry.ts` captures the config in a top-level `CONFIG` const
  and reuses it in `mount()`; the overlay dodges this only because it mounts synchronously when `body`
  already exists. This was a real Phase-1 bug found in-browser.
- **Sidecar port conflicts:** default 5178 is shared with any running nitpicker install. Use
  `--sidecar-port` (and matching `--endpoint`) to isolate; `--no-sidecar` to reuse an external one.
- To avoid gzip handling on the injection path, the proxy sends `accept-encoding: identity` upstream and
  resets `content-length`/`transfer-encoding`/`content-encoding` on the rewritten HTML.
- **WebSocket (HMR) upgrades are hand-rolled, NOT `proxy.ws`.** `http-proxy@1.18.1`'s ws pass leaves its
  outgoing HTTP parser attached to the upgraded socket and throws `Parse Error: Expected HTTP/` on the
  first inbound WebSocket frame, tearing the socket down before the 101 reaches the browser. `server.ts`
  `forwardUpgrade` replaces it with a raw-socket tunnel (open the same upgrade upstream, relay the 101 +
  headers verbatim, then pipe bytes both ways with no parser in the middle). `ws` is off in the
  `createProxyServer` opts. If you ever route ws back through http-proxy, this regresses.
- **The proxy strips `Origin` on forwarded upgrades — load-bearing for Next 16 / Turbopack HMR.** Turbopack's
  dev server rejects the `/_next/webpack-hmr` upgrade with a raw non-HTTP `Unauthorized` (that's the
  `Parse Error` upstream) whenever `Origin` is present and outside its dev-origin allowlist. The browser
  always sends the *harness* origin, which never matches — and even the target's own `127.0.0.1` origin is
  rejected (only `localhost`/LAN hosts are allowlisted by default; `127.0.0.1` is not). A reverse-proxy hop
  is a trusted server-to-server request, so `forwardUpgrade` does `delete headers.origin` before forwarding;
  with no Origin the dev server returns 101. **This is the whole Phase-0 hydration fix:** without the HMR
  socket, Turbopack's runtime stalls before client hydration attaches per-node `__reactFiber$…`, so the
  fiber walk (hence `component` name) returns nothing *through the proxy* while it works served-direct.
  Regression-guarded by `tests/proxy-ws.test.ts`; manual A/B rig is `tests/fixtures/next16-app` (its README).
- **Injecting the overlay makes the app log a *recoverable* React hydration mismatch on `<html>`.** The
  overlay sets `documentElement.style.transition` on mount (`vendor/nitpicker/core/overlay.ts`), which the
  hydrating tree doesn't expect. React 19 recovers (fibers still attach, verified), but the dev error
  overlay pops and then 403s on `/__nextjs_original-stack-frames` + `/__nextjs_font/*` (same Turbopack
  cross-origin-dev-resource gate, HTTP side). Pre-existing to the injected overlay, orthogonal to the
  proxy; only became *visible* once Phase 0 let hydration actually run. A proper fix belongs with the
  overlay-engine lift (report Phase 2), not the proxy.
- **`tests/fixtures/**` is excluded from the root `tsconfig`.** The fixture is a separate Next app whose
  own `@types/node` globally augments `process.env.NODE_ENV` to read-only; if `tsc` pulls its
  `next-env.d.ts`/`.next/**` in via `tests/**/*.ts`, that augmentation leaks and breaks the vendored
  `NODE_ENV=` test assignments program-wide. Keep the exclude.
- **`Overlay.appWidth()` measures `documentElement.clientWidth`, NOT `window.innerWidth`** — clientWidth
  EXCLUDES a classic (non-overlay) scrollbar's gutter, innerWidth includes it. The frozen-region clone,
  the drag clamp/dim-bands, and the pane crop all lay out against appWidth, so with innerWidth the
  hotkey-freeze clone was `scrollbarWidth` px too wide and the opaque snapshot appeared to SHIFT the page
  when it replaced the live view (only with classic scrollbars — macOS overlay scrollbars are 0-width, so
  it reproduces only where the dev has "always show scrollbars" on / on Win-Linux). It's cached in
  `viewportContentW`, refreshed ONLY at mount / resize / drag-start / freeze-entry (never per-mousemove —
  reading clientWidth forces a synchronous layout). Falls back to innerWidth when clientWidth is 0
  (jsdom/pre-layout), so unit tests + overlay-scrollbar browsers are behavior-identical. Note
  `documentElement.clientWidth` is a special case that returns the viewport width (minus scrollbar)
  regardless of the pane's `<html>` margin-right — verified in-browser. Regression-guarded in
  `tests/region-persist.test.ts`.
- **The region selection visual (dim bands + red outline) PERSISTS after mouse-up** until the queue card
  is committed (Queue) or dismissed (Cancel/Esc/backdrop) — so the user sees what they framed while
  composing. `onDragEnd`/`captureFrozen` deliberately DON'T `clearDrag()` (they only null the drag
  *state*, already done); `unfreeze()` is the SINGLE teardown point (it now calls `clearDrag()`), so every
  card-close path clears the selection exactly once. Reverting any of these re-introduces the "selection
  vanishes on release" bug. This is the injected-overlay flow only; the builder-shell queues a region
  immediately on release (no compose card), so it has no persistent-selection state. Guarded in
  `tests/region-persist.test.ts`.

## Builder-shell interaction (Phase 2): the `Env` seam + the §5 single-offset rule

- **The overlay engine is parameterized over a DOM `Env { doc, win }` handle** (`vendor/nitpicker/core/env.ts`)
  so ONE engine serves both modes: injected mode reads the ambient globals (the default), the shell reads the
  proxied iframe's `contentDocument`/`contentWindow`. Every ambient ref in `core/overlay.ts` + `core/region.ts`
  routes through it; `redbox.ts`/`elements.ts`/`react/react-source.ts` were already ambient-free and are reused
  verbatim. **Every seam defaults to ambient**, so the injected overlay is behavior-preserving — do NOT drop the
  defaults. This is a harness-local delta (nitpicker is archived); preserve it on re-sync (see
  `vendor/nitpicker/README.md`). Proved by `tests/env-seam.test.ts`.
- **The geometry rule that keeps the parent highlight/red box exactly over the iframe (`src/shell/geometry.ts`,
  report §5): translate iframe-content coords by the iframe's own offset (`frame.getBoundingClientRect()`)
  EXACTLY ONCE** — add it content→parent (highlight placement), subtract it parent→content (drag point → capture
  rect). The highlight is a `position:fixed` layer in the PARENT viewport, so the offset is added a single time;
  the "double-offset" bug is applying it twice (e.g. a fixed layer AND nesting inside the already-offset stage).
  Regression-guarded by `tests/shell-geometry.test.ts`. Because `getBoundingClientRect()` inside the iframe already
  reflects the iframe's own scroll, the highlight tracks scroll for free once you re-run placement on the iframe's
  `scroll` event — `src/shell/entry.ts` attaches iframe scroll+resize (and parent resize) listeners for exactly this.
- **The shell's region capture crops NO gutter** (`appWidth = iframeWin.innerWidth`): unlike the injected dock,
  the shell's chrome lives in the parent, not the iframe, so the iframe raster has nothing to crop. Pass a
  detached parent `<div>` as `captureRegion`'s `hostEl` — it's never inside the iframe, so `ignoreElements`
  is a no-op (passing the iframe body would exclude everything).
- **The shell reuses the sidecar queue lifecycle, not the injected `Overlay` class** — element/region marks feed
  `ShellChrome`'s existing Phase-1 queue + `Transport` (region `_pending`/`_blob` awaited on send, same as the
  overlay). Mounting the full `Overlay` in the shell would double the chat/dock and fight the shell's flex layout;
  the shell drives the parameterized engine primitives directly instead.
- **Browser E2E needs Node ≥20.19** for the `chrome-devtools-mcp` bridge. The repo's
  default `node` may be older; `export PATH="$HOME/.nvm/versions/node/v22.*/bin:$PATH"` before driving the browser.
  The `tests/fixtures/next16-app` (`PricingCard` → `[data-testid="pricing-Pro"]`) is the standard target: run it on
  `:3111`, point the harness at it, open `/__nitpicker-harness/shell`.

## The feedback driver (idle agent → still gets driven)

`poll`/`poll --watch` only delivers while the agent is actively running it. So feedback that lands after
a turn ends would sit undriven. The driver closes that gap with the "blocking watcher +
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
npm run build          # scripts/build.mjs (esbuild → dist/) + tsc -p tsconfig.build.json (→ dist/types)
npm run typecheck      # tsc --noEmit
npm test               # vitest: tests/** (proxy) + vendor/nitpicker/tests/** (reused core)
npm run verify-pack    # CLEAN-INSTALL regression: pack → pnpm --prod install → run bin + embedded smoke
npm run dev -- --target http://localhost:3000     # dev: run the TS source under tsx (no build)
npm run dev -- ./path/to/app                       # dev: embedded-agent mode (owns the dev server + live pane)
npm run dev -- ./path/to/app --no-agent            # dev: embedded dev-server ownership, classic sidecar sink
```

`start`/`harness`/`poll` are tsx aliases kept for local dev (identical to `dev`). Consumers never touch tsx.

## Packaging: the build + consumer contract (why `dist/`, not `tsx`)

**The package ships COMPILED JS in `dist/` and runs it with plain `node` — there is NO `tsx` at runtime.**
This is load-bearing: running the TS **source** under `tsx` broke every clean consumer install (Loom's
`loom-embed`, `make dogfood`). `tsx` is a **devDependency**, and even in `dependencies` it fails under
pnpm's isolated `node_modules` — the old `bin`/`src/sidecar.ts` did `require.resolve("tsx/dist/cli.mjs")`,
but tsx's `exports` map only exposes `./cli`, so pnpm consumers hit `ERR_PACKAGE_PATH_NOT_EXPORTED` → the
`npx tsx` fallback → exit 127. The in-repo vitest/typecheck suite passed while this was broken because dev
deps are present there; only a real out-of-repo prod install exposes it (hence `npm run verify-pack`).

- `scripts/build.mjs` (esbuild) produces three **server** bundles — `dist/cli.js` (the `bin` target),
  `dist/index.js` (the `startEmbeddedBuilder` library + interface re-exports), `dist/sidecar.js` (the
  vendored transport, spawned as `node dist/sidecar.js`) — plus three self-contained **browser** IIFEs
  under `dist/browser/{overlay,shell,builder}.js`. Server bundles use `packages:"external"`, so the only
  runtime `dependency` is **`http-proxy`**; the Claude Agent SDK stays an `import(SDK_MODULE)` runtime
  optional dep; `esbuild`/`html2canvas` moved to **devDependencies** (build-only).
- `tsc -p tsconfig.build.json` emits `.d.ts` into `dist/types/**` (rootDir `.`), so `package.json`
  `types` → `dist/types/src/index.d.ts`. This is the typed surface **Loom pins**.
- `package.json`: `main`/`exports` → `./dist/index.js`, `types` → `./dist/types/src/index.d.ts`, `bin`
  still `bin/nitpicker-harness` (now a thin node launcher that `import()`s `dist/cli.js`). `prepare` +
  `prepack` run the build, so a **git-dependency** install (runs `prepare` with devDeps present) and an
  `npm publish` (runs `prepack`) both ship a runnable, tsx-free package; `files` includes `dist` + `vendor`.
- **`src/*/build.ts` and `src/sidecar.ts` are dual-mode:** they prefer the prebuilt `dist/` artifact and
  only fall back to esbuild-from-source / `tsx` (resolved via `require.resolve("tsx/cli")`) when no `dist/`
  is present — i.e. an in-repo tsx/vitest run. `esbuild` is `await import()`ed **only** on that fallback so
  it's never required in a clean consumer install. So both `npm test` (fallback path, no dist needed) and a
  built package (prebuilt path) are green; `scripts/verify-pack.sh` guards the built/clean path.
- **Consumer contract for Loom:** import path is unchanged (`import { startEmbeddedBuilder, makeBackend,
  LOOM_BUILDER_SYSTEM_PROMPT, … } from "nitpicker-harness"` and the `nitpicker-harness` CLI command); only
  the resolved files moved from `src/*.ts` to `dist/*.js`. The `vendor/nitpicker/next/*` source-stamp files
  are still shipped verbatim (copied into the target, not imported), so that wiring is unaffected.
- **After editing any browser entry or the vendored core, rebuild** (`npm run build`) before packing — a
  prebuilt `dist/` is served as-is; the in-memory bundle cache note above still applies to a running proxy.

## Verify a change end-to-end

Scaffold or point at a Next dev app, run the harness at it, open the harness URL, and confirm: dock
appears, a Region drag yields a red-boxed PNG, Element pick returns `component` + `selector`, and a
`Send to agent` batch is drained by `nitpicker-harness poll --session <id>`. (A throwaway Next app under
a gitignored `/verify-app/` or the scratchpad is the standard fixture.)

## Scope

Phase 1 = localhost dev proxy, Next.js reference target. Out of scope: browser extension, platform
layer. `file:line:col` source is wired by default on owned Next builds (needs the target's bundler +
`@babel/core`); non-owned/non-Next apps degrade cleanly to component+selector+text+route. See README
"done vs deferred".

**Embedded-agent mode (W1)** adds dev-server ownership + an in-pane agent behind the SSE gateway; the
`startEmbeddedBuilder()` library is the surface Loom pins (D7/D9). Out of W1's lane (Loom-side, W2–W5):
the control-plane `Runtime`/auth, multi-runtime apps (frontend + FastAPI backend — the harness proxies
ONE origin), git-per-turn, and headless self-verify. Marks are queued as chips and only sent on an
explicit turn boundary (the `source` file:line:col is the stable anchor; selectors can go stale as the
agent's edits churn the DOM).
