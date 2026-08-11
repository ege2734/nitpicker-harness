# Spike: truly-instant region capture via DOM-clone-at-keypress

**Task:** make `Cmd/Ctrl+Shift+X` region capture draw with *zero visible freeze* while preserving
hover-card correctness, by snapshotting/cloning the DOM cheaply at keypress and deferring the expensive
`html2canvas` raster off the critical path.

**Verdict: VIABLE and a clear, shippable win.** A plain `cloneNode(true)` + a small set of targeted
mitigations produces an instant (~20 ms) frozen visual that *preserves the hover-only card*, and the
unavoidable ~1–2 s `html2canvas` raster can be moved off the keypress onto the already-accepted
dock-path "capture at Queue-commit, show a placeholder" pipeline. The keypress freeze goes from
**~700 ms–2 s → ~20 ms** with no loss of the feature's reason-to-exist (freezing hover UI). The cost is
a set of well-understood clone-fidelity edges (portaled CSS-`:hover` tooltips, scroll offset, form/anim
state) each with a cheap targeted fix. I recommend promoting this to a ship task.

---

## 1. How the current code works (and why it freezes)

The hotkey path *already* tries to "freeze at keypress", but it does it with the expensive tool:

- `overlay.ts:288` `onKeydown` → `enterRegionFrozen()` (`overlay.ts:295`)
- `enterRegionFrozen` arms region mode, shows the **"Freezing viewport…"** cue (`overlay.ts:182,302`),
  then `scheduleFreeze()` (`overlay.ts:319`) double-rAFs into `freezeViewport()` (`overlay.ts:347`)
- `freezeViewport` calls `rasterizeViewport()` (`region.ts:38`) → **`html2canvas(document.body)`**
  (`region.ts:42`). This is a **single synchronous main-thread block** — the whole viewport is
  unresponsive for its duration. On mouse-up, `captureFromFrozen()` (`overlay.ts:488`) just annotates
  the already-rasterized canvas, which is fast.

So the freeze *is* the at-keypress `html2canvas`. The "Freezing viewport…" cue (`np-fast-r6`) was added
as a stopgap so the block reads as a deliberate step rather than a hang. The dock path, by contrast, is
already instant: it draws the selection box on the **live** page and rasters later at Queue-commit
(`captureRegionShot` `overlay.ts:473`, `enqueueRegion` `overlay.ts:798`), showing a "capturing…"
placeholder in the pane (`renderQueue` `overlay.ts:906`, `fillRegionBody` `overlay.ts:763`). **The
hotkey only freezes because it needs the hover-only UI captured before the mouse moves.**

## 2. Method

I ran everything in a real browser (headless Chromium via Playwright MCP) against a synthetic
"dashboard" page (`scratchpad/exp/index.html`) with the hard cases baked in: ~1.3k–6.1k element DOM,
a drawn `<canvas>` chart, a declarative `<svg>` chart, a **CSS-`:hover`-only tooltip** that vanishes on
mouse-move, a scrolled inner scroll container, a typed `<input>`, a `position:sticky` header, and a
`position:fixed` badge. I used html2canvas **1.4.1** — the exact version the harness depends on
(`package.json`) and vendors through `region.ts:39`.

Measurements were taken with `performance.now()` around each operation; hover state was driven with a
**real pointer** (`page.mouse.move`) because `:hover` cannot be faked from JS. All raw commands and
outputs are reproducible from `scratchpad/exp/`.

## 3. Evidence — timings

At **6082 elements**, headless Chromium, Apple-silicon Mac, `scale: 1` (clean run):

| Operation | Time |
|---|---:|
| `document.body.cloneNode(true)` (plain structural clone) | **1–10 ms** |
| copy `<canvas>` bitmaps into clone (→ `<img>`) | ~2–5 ms |
| scoped hover-bake (inline computed styles for the 4-node hovered card) | ~5 ms |
| **build frozen clone (total)** | **~5 ms** |
| attach clone to document + force layout (show the frozen visual) | **~15 ms** |
| **⇒ time-to-interactive at keypress (build + attach)** | **~20 ms** |
| `html2canvas(document.body)` — *current* at-keypress block | **717 ms** |
| `html2canvas(frozenHolder)` — deferred raster of the clone | **721 ms** |
| `getComputedStyle` walk over *all* 6082 nodes (for reference) | ~1100 ms |

Key relationships (these are the load-bearing findings, and they hold across DOM sizes 1.3k→6.1k):

- **A plain clone is ~1000× cheaper than an `html2canvas` raster** (1 ms vs ~700 ms; ratio is
  machine-independent). This is the only truly "instant" primitive available — there is **no
  synchronous DOM→bitmap web API**, which is the whole reason `html2canvas` exists.
- **`html2canvas`'s dominant cost *is* the computed-style walk.** html2canvas ≈ the raw
  `getComputedStyle` walk (~700 ms vs ~1100 ms; html2canvas's targeted property reads are a bit
  leaner than reading all ~550 longhands). **Corollary: any approach that inlines computed styles for
  the *whole page* to preserve appearance costs the same as just running html2canvas** — so "cheap
  clone that bakes all styles" is a contradiction. Cheapness requires the clone to stay *plain* and let
  the page's stylesheets re-apply (they do, since the clone lives in the same document).
- **Rastering the frozen clone costs the same as rastering the live DOM** (721 vs 717 ms). Attaching a
  full-body clone does **not** meaningfully slow the later `html2canvas(holder)` call — html2canvas only
  processes the target subtree, and hiding the live content during the raster changed nothing (720 vs
  721 ms). (An earlier run showing ~2 s was a self-inflicted bug — I baked inline styles onto all 6084
  nodes; with correct scoping the penalty disappears. Documented so it isn't repeated.)

The reported "~2 s block" is this same ~700 ms operation on a heavier real app / slower machine / with
DevTools open — scale-independent, dominated by DOM traversal + style computation, not pixel fill (the
existing `region.ts:1-4` comment already notes this). The point stands regardless of the absolute
number: **build-frozen is ~1 ms; raster is ~1–2 s; moving the raster off the keypress is the win.**

## 4. Evidence — correctness of a clone (the hard cases)

Driven with a real pointer over the CSS-`:hover` tooltip, then probed:

| Case | Plain `cloneNode(true)` | Mitigation | After mitigation |
|---|---|---|---|
| **CSS `:hover` tooltip** | **LOST** — clone isn't under the pointer, so `:hover` rules don't match (live=`visible`, clone=`hidden`) | Inline computed styles for the hovered element's subtree ("bake") | **Preserved** — cloned tooltip `visible`, correct text, **survives after the real cursor leaves** (verified visually — see `frozen-visual.png`) |
| **`<canvas>` chart** | **BLANK** — `cloneNode` does not copy the bitmap | Replace clone `<canvas>` with `<img src=liveCanvas.toDataURL()>` and `await img.decode()` before raster | Rendered (must await decode — an undecoded img rasters blank) |
| **`<svg>` chart** | **OK** — declarative, lives in the DOM, clones verbatim | — | OK |
| **Computed styles / CSS vars / stylesheet rules** | **OK** — the clone is in the same document; all author stylesheets re-apply (only *state-driven* pseudo-classes are lost) | — | OK |
| **Inner scroll position** | **LOST** — structural clone resets `scrollTop` to 0 (live=540) | Walk scroll containers, copy `scrollTop/Left` to clone **after attach** | Restored |
| **`<input>` value (typed)** | Preserved in Chromium (observed) but **spec-inconsistent** for `checkbox.checked`/`select`/`contenteditable` | Walk form controls, copy `.value/.checked/.selectedIndex` | Robust cross-browser |
| **Page scroll offset (viewport)** | Clone starts at content-top → a *scrolled* page would freeze the wrong region | Wrap clone, `transform: translate(-scrollX,-scrollY)` so the current viewport aligns to holder origin | Correct region frozen |
| **Cross-origin images / tainted canvas** | `toDataURL()` throws on a tainted canvas → caught, left blank | Same limitation `html2canvas` already has (`useCORS`); no regression | Parity with today |
| **CSS animations / video / cross-origin iframe** | An attached *live* clone keeps animating; x-origin iframe blank | `#holder * { animation-play-state:paused!important; transition:none!important }`; iframe blank = parity | Frozen |
| **Duplicate `id`s during display window** | Clone duplicates ids | `getElementById` returns first-in-tree-order = the **live** node, so app JS is unaffected; clone is `pointer-events:none` and lives only seconds | Low risk |

**Visual proof (`frozen-visual.png`, in this directory):** hover the tooltip → build+attach the frozen
clone → move the real cursor far away. The live tooltip is gone (`visibility:hidden`) but the frozen
clone still shows **"HOVER-ONLY: p95 latency 812 ms · this card only exists while hovered"**, with the
sticky header, card grid, and styling all intact. This is the core correctness claim demonstrated
end-to-end.

### The one genuinely fragile part: hover-bake scope

Preserving `:hover` requires knowing *which* elements change appearance under hover and baking their
computed styles. `document.querySelectorAll(':hover')` returns the **entire ancestor chain**
(`HTML,BODY,grid,card,…`), not "the elements a `:hover` rule restyles" — the tooltip is targeted by a
descendant selector (`.card:hover .tooltip`) and is a *child* of the hovered card, not in the chain
itself. The workable heuristic I validated: **walk the hover chain from deepest outward and bake the
shallowest ancestor whose subtree is under a node cap (≈500)** — for a tooltip-in-a-component this picks
the small component (4 nodes, ~5 ms) and captures the tooltip. It breaks for:

- **Portaled tooltips** (Radix/MUI/Recharts render the tooltip at `document.body`, outside the hovered
  subtree). In practice most portaled tooltips are **JS-toggled** — their presence + inline
  `opacity/transform` *is* the state, which a plain structural clone captures for free. Only
  CSS-`:hover`-driven portaled tooltips (rare) are missed.
- Sibling-combinator hover (`.a:hover ~ .b`) where `.b` is outside the baked subtree.

Mitigation if we want to be thorough: also bake any element matched by scanning stylesheet rules whose
selector contains `:hover` and currently matches — but that's more code. The cap-scoped subtree bake is
the 90% solution and is what I'd ship first, with the limitation documented.

## 5. Red-box coordinate space (Q3): stays correct

The selection is measured in **viewport CSS px** (`clientX/clientY`, `dragRect` `overlay.ts:55`), and
`compositeRegion` (`redbox.ts:50`) multiplies that rect by the capture `scale`. The frozen clone is
displayed in a `position:fixed; inset:0` holder occupying the **same viewport CSS space**, and the
deferred raster runs `html2canvas(holder, {x:0,y:0,width:innerWidth,height:innerHeight})` — the identical
coordinate contract `rasterizeViewport` uses today (`region.ts:42-48`). So the red-box math is
**unchanged and correct**, with one new requirement: the holder must mirror the live **scroll offset**
(the `translate(-scrollX,-scrollY)` above) so "viewport-space (0,0)" means the same region the user drew
on. No change to `redbox.ts` / `annotateRegion` is needed.

## 6. Recommendation & implementation shape

**Ship it.** Replace the at-keypress `html2canvas` with a cheap frozen-clone snapshot, and reuse the
existing dock-path deferred-raster machinery so the raster happens *after* the region is picked
(overlapped with the user typing their note, covered by the existing "capturing…" placeholder).

**Where it hooks (all in `vendor/nitpicker/core/`):**

1. **`overlay.ts` `enterRegionFrozen` (`:295`)** — keep the instant `setMode("region")`. Replace
   `scheduleFreeze()`/`freezeViewport()` (`:319`,`:347`) with a synchronous
   `snapshotFrozen()` that:
   `cloneNode(true)` → canvas→`<img>` (+`decode()` on the deferred path) → scoped hover-bake →
   `transform: translate(-scrollX,-scrollY)` → copy scroll/form state → attach a
   `position:fixed;inset:0;pointer-events:none` holder with animations paused. **~20 ms, one frame.**
   The "Freezing viewport…" cue (`:182`,`:302`) can be **deleted** — there is nothing to wait for.
2. **`region.ts` `rasterizeViewport` (`:38`)** — generalize to take the element to raster (the holder)
   instead of hard-coding `document.body`. Everything else (`checkCaptureScale`, `annotateRegion`,
   `compositeRegion`) is unchanged.
3. **`overlay.ts` `onDragEnd`/`captureFromFrozen` (`:388`,`:488`)** — on mouse-up, tear down the frozen
   holder and route to the **dock path's** deferred pipeline: `enqueueRegion(rect, rasterHolder(...),
   text)` where `rasterHolder` is the `captureRegionShot`-shaped deferred raster of the (still-attached-
   until-rastered) clone. Reuse `pendingDockRasters`, `fillRegionBody`, and the pane reflow-lock
   verbatim. The queue card opens **instantly** with a "capturing…" thumbnail; the blob lands ~1 s
   later; `send()` already awaits `_pending` (`overlay.ts:1005`).

**Net UX:** keypress → region armed + frozen visual in ~20 ms → user drags over the frozen hover card →
card opens instantly → types note while the raster runs in the background → Queue. The user never waits
on `html2canvas` to *do* anything. The ~1–2 s cost still exists but is fully off the interaction path —
exactly the model the dock path already ships and users already accept.

**Accepted limitations (document in code + SKILL.md):**
- CSS-`:hover`-driven **portaled** tooltips and sibling-combinator hover effects may not be frozen
  (JS-toggled portaled tooltips *are*). The cap-scoped bake covers the common tooltip-in-component case.
- Truly exotic live state (mid-playing video frame, WebGL canvas without `preserveDrawingBuffer`,
  cross-origin iframes) degrades to blank — **the same limits `html2canvas` already has today.**
- The frozen visual is a re-layout of a clone, not a pixel copy; in rare cases (subpixel font hinting,
  `@container` queries keyed off the holder) it can differ by a hair from the live paint. Cosmetic.

## 7. Alternatives considered (and why the clone wins)

- **Keep `html2canvas` at keypress but make it non-blocking / off-main-thread.** Not possible:
  html2canvas is synchronous JS, and it reads the DOM + `getComputedStyle`, neither of which exists in a
  Web Worker. It cannot yield.
- **`foreignObject`-SVG rasterization (modern-screenshot / html-to-image style).** Browser-native paint,
  potentially faster — but it *still* requires inlining computed styles (same ~700 ms walk to preserve
  hover), taints the canvas on any cross-origin resource (breaks `toBlob`), and doesn't render
  `<canvas>`/external `<img>` without the same data-URL embedding. No net win over the clone, more
  failure modes.
- **Native capture (`getDisplayMedia`, Region Capture, CDP `Page.captureScreenshot`).** Permission
  prompt / not synchronous / captures OS chrome / unavailable to in-page JS. Out of scope (extension
  territory).
- **Do nothing for static captures.** For captures with *no* hover-only UI, the dock path is already
  instant — one cheaper option is to make the hotkey behave like the dock path unless hover UI is
  detected. But detecting "worth freezing" is itself heuristic, and the clone approach makes *every*
  capture instant, so it strictly dominates.

## 8. Reproduce

```
# from the harness worktree
npm install
# experiment page + html2canvas 1.4.1 live in scratchpad/exp/ (index.html)
# served on :8791; driven via Playwright MCP with a real pointer for :hover.
# Core measured pipeline (6082 nodes): build frozen ~5ms, attach ~15ms,
# raster live 717ms == raster frozen holder 721ms.
```

Artifacts in this directory: `report.md` (this file), `frozen-visual.png` (hover card frozen after the
cursor left — the correctness proof). Experiment source: harness worktree
`scratchpad/exp/index.html`.
