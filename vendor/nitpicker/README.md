# vendor/nitpicker

Code **copied verbatim** from [nitpicker](https://github.com/ege2734/nitpicker)
(`assets/nitpicker/`), so nitpicker-harness is self-contained and does **not** depend back on the
nitpicker repo. nitpicker-harness will become the canonical home for this code when nitpicker is
archived.

**Vendored from nitpicker `main` @ `a8d109b`** — includes the docked feedback pane, the region-mode
fixes (full-viewport red-box coordinate space, instant draw, Queue-time async raster, click-to-view/edit
item modal, click-no-drag cancel) and the region-speed work (instant `Cmd/Ctrl+Shift+X` region capture via
a cheap DOM-clone freeze at key-press + deferred html2canvas raster). When re-syncing, keep the local
`react-source` delta below.

What's here and how the harness uses it:

- **`core/`** — `@nitpicker/core`, the framework-agnostic overlay (dock, region capture + red-box
  compositor, element picker + descriptor builder, docked feedback pane + item modal, transport client).
  The harness bundles this into the injected browser overlay (`src/overlay/entry.ts`) — it is the *same*
  `Nitpicker.mount()` the install skill uses, just delivered by the proxy instead of the target's bundler.
- **`react/react-source.ts`** — the React/Next `resolveElement` seam: component name from the runtime
  fiber walk + `data-nitpicker-source` read. Imported by the overlay entry.
- **`react/dev-overlay.tsx`** — the Next/React `"use client"` mount used by the *install* skill. Kept
  for reference only; the harness injects its own mount and does not use this file (it imports `react`,
  which the harness doesn't depend on).
- **`server/`** — the local sidecar transport (`node:http` only). The harness CLI spawns it; it also
  carries a harness-local delta (the `/pending` + `/wait` endpoints and the `drains` counter — see
  "Local modifications" below) that backs the feedback driver.
- **`cli/poll.ts`, `cli/verify.ts`** — the agent's long-poll client and the prod-leak scanner. `poll` is
  reused by `nitpicker-harness poll`.
- **`next/`** — the dev-only Babel source-stamp loader/plugin plus `with-nitpicker-source.cjs`, the
  one-line `withNitpickerSource(nextConfig)` wrapper that composes them into the *target's* `next.config`.
  Wired as a **standard setup step** for exact `file:line:col` on owned Next builds (see `SKILL.md`).
- **`tests/`** — nitpicker's units for the reused core (selector, red-box math, React glue, sidecar
  drain, prod guard, plus the docked-pane/pane-lock/item-modal/hotkey/instant-region overlay behavior),
  run by this repo's vitest to prove the vendored code still behaves.

## Local modifications

Kept as close to upstream as possible. This is a **harness-local delta**: nitpicker is being archived, so
it is **not** upstreamed — preserve it on every re-sync (do NOT blind-copy `react-source.ts` /
`react-source.test.ts`, `server/index.ts`, or `server/store.ts` from upstream):

- **`react/react-source.ts`** — the fiber walk now also reads the component name off React 19's
  `_debugOwner` **owner-info** object (name on `.name`, no `.type`), in addition to the pre-19 fiber
  `.type` path. Without this, element-pick returned no `component` on React 19 (verified against React
  19.0). Covered by an added case in `tests/react-source.test.ts`.
- **`server/index.ts` + `server/store.ts`** — the non-draining `GET /pending` (cheap queued count) and
  `GET /wait` (long-poll that resolves the instant the queue is non-empty) endpoints the feedback driver
  needs, plus the per-session `drains` generation counter in `store.ts` (bumped only on a real delivery)
  that both endpoints report as the driver's loop guard. Draining stays exclusive to `/poll`, so these
  never race away an item. Marked in-file; preserve on re-sync.

- **`core/types.ts` + `server/store.ts` + `cli/poll.ts` — the `text-edit` QueueItem kind** (builder-shell
  Phase 4). The shell's inline click-to-edit flow (`src/shell/entry.ts`) captures a visible-text change as a
  `text-edit` mark carrying `element` (source/selector/component, same as element mode) plus top-level
  `oldText`/`newText`. `core/types.ts` adds the kind + the two fields to `QueueItem`; the sidecar is
  schema-light so `server/` only widens the `kind` union (items pass through opaquely); `cli/poll.ts` renders
  the mark for the agent (source, `old → new`, component, selector). Additive and injected-mode-neutral (the
  injected overlay never emits this kind). Preserve on re-sync (same rule as the deltas above).
- **`core/env.ts` (new) + the `Env` seam through `core/overlay.ts` + `core/region.ts`** — the overlay
  engine was written against the ambient `document`/`window` globals. The builder shell (`src/shell`) needs
  the SAME engine to read a DIFFERENT document — the same-origin proxied `<iframe>`'s
  `contentDocument`/`contentWindow` — while rendering the highlight + red box in the PARENT shell. So every
  ambient `document.`/`window.` reference in `overlay.ts` and `region.ts` now routes through a passed-in
  `Env { doc, win }` handle (`core/env.ts`, `ambientEnv()`), added to `NitpickerOptions.env`. **Every seam
  defaults to the ambient env**, so injected mode (`src/overlay`) is byte-for-byte behavior-preserving; the
  shell passes the iframe's env (`captureRegion(rect, scale, host, appWidth, env)` etc.). `core/redbox.ts`
  and `core/elements.ts` were listed for this pass but are already ambient-free (element/canvas-relative
  math only), so they're reused verbatim — as are `react/react-source.ts` (fiber walk off the passed node).
  Covered by `tests/env-seam.test.ts`. Preserve on re-sync (same rule as the deltas above).
