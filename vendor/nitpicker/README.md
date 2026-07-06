# vendor/nitpicker

Code **copied verbatim** from [nitpicker](https://github.com/ege2734/nitpicker)
(`assets/nitpicker/`), so nitpicker-harness is self-contained and does **not** depend back on the
nitpicker repo. nitpicker-harness will become the canonical home for this code when nitpicker is
archived.

**Vendored from nitpicker `main` @ `a8d109b`** — includes the docked feedback pane, the region-mode
fixes (full-viewport red-box coordinate space, instant draw, Queue-time async raster, click-to-view/edit
item modal, click-no-drag cancel) and the region-speed work (instant `Cmd/Ctrl+Shift+X` mode switch via
deferred raster + "freezing viewport…" cue). When re-syncing, keep the local `react-source` delta below.

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
- **`server/`** — the local sidecar transport (`node:http` only). The harness CLI spawns this unchanged.
- **`cli/poll.ts`, `cli/verify.ts`** — the agent's long-poll client and the prod-leak scanner. `poll` is
  reused by `nitpicker-harness poll`.
- **`next/`** — the dev-only Babel source-stamp loader/plugin. Not on the harness's default path;
  documented as the **opt-in** for exact `file:line:col` (wire into the *target's* `next.config`).
- **`tests/`** — nitpicker's units for the reused core (selector, red-box math, React glue, sidecar
  drain, prod guard, plus the docked-pane/pane-lock/item-modal/hotkey/instant-region overlay behavior),
  run by this repo's vitest to prove the vendored code still behaves.

## Local modifications

Kept as close to upstream as possible. This is a **harness-local delta**: nitpicker is being archived, so
it is **not** upstreamed — preserve it on every re-sync (do NOT blind-copy `react-source.ts` /
`react-source.test.ts` from upstream):

- **`react/react-source.ts`** — the fiber walk now also reads the component name off React 19's
  `_debugOwner` **owner-info** object (name on `.name`, no `.type`), in addition to the pre-19 fiber
  `.type` path. Without this, element-pick returned no `component` on React 19 (verified against React
  19.0). Covered by an added case in `tests/react-source.test.ts`.
