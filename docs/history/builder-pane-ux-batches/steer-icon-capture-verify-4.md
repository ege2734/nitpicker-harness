# Fix region-capture icon-font rendering — WITH a real browser-driven verification loop

Same rapid protocol: `fm/harness-overlay-cookie-c2`, keep typecheck+vitest green, commit+push,
report `done` with new SHA, **skip /no-mistakes**. Builder/capture only; classic shell unchanged.

## The problem (your previous fix did NOT work — verified by the captain)
Your `ensureFontsReady()` (await `document.fonts.ready`) fix is in the shipped build, hard-reloaded,
and region-capture screenshots STILL render every icon as a tofu box (□). The live app renders the
icons fine — it's ONLY the html2canvas(-pro) capture that loses them. Awaiting fonts is necessary
but NOT sufficient: html2canvas is not reproducing the **Phosphor icon-font glyphs** into its raster
even when the font is loaded. `@loom/ds` icons are a self-hosted Phosphor **icon web font**
(`@font-face`, 3 weights — see how the DS ships them; the glyphs are private-use codepoints).

## THE KEY CHANGE: verify it yourself in a real browser, iterate until icons render
You shipped blind last time because your sandbox has no Loom shell. Fix that: **build a self-contained
reproduction you can drive with Playwright/browser automation** (you have Playwright MCP + browser
tools) so you can capture, LOOK at the resulting image, and iterate autonomously until the icons are
real — do not ship again on a unit test alone.

1. **Minimal repro page (in-repo, e.g. under an examples/ or test fixture dir):** a tiny HTML/app that
   loads an **icon web font via `@font-face`** exactly the way `@loom/ds` does (self-hosted woff2,
   private-use-area glyphs) and renders a row of icon glyphs + a couple of text labels — mirroring the
   Loom toolbar (Fork/Share/Deploy/Preview…). This reproduces the exact failing condition without
   needing Loom. Reuse a real icon font (bundle a small woff2 or the Phosphor subset) so the glyphs are
   genuine icon-font codepoints, not just text.
2. **Drive the capture with Playwright:** launch the harness over that repro page, programmatically
   perform a region select over the icon row, trigger the capture, and **save the resulting captured
   image** (the `_blob`/lightbox image) to a file. Then load/screenshot that image and INSPECT it:
   the icons must render as real glyphs, not □. Use a concrete check — visually confirm via a browser
   screenshot AND, ideally, a programmatic signal (e.g. the captured region is not uniformly
   blank/tofu; compare a captured icon cell against the live DOM rendering, or assert non-trivial pixel
   variance where an icon should be).
3. **Iterate the fix against that loop** until the captured image shows the icons:
   - **Preferred fix:** embed the icon `@font-face` into the html2canvas render — inline the woff2 as a
     **base64 data-URI `@font-face`** injected via html2canvas's `onclone` hook so the glyph outlines
     are guaranteed present in the clone; and/or enable **`foreignObjectRendering: true`** for the
     capture (renders through the real font stack). Try them, keep whichever actually renders the icons
     in YOUR captured image.
   - Keep the existing oklab/oklch (`html2canvas-pro`) handling intact and keep `ensureFontsReady`.
   - Watch for CORS/taint: a data-URI font avoids cross-origin taint; if you use foreignObjectRendering,
     confirm the capture isn't tainted/blanked.
4. Apply the working fix to the real capture path (`vendor/nitpicker/core/region.ts` and wherever the
   shared capture lives) so live Loom captures get it too.

## Report
Add a regression test (the repro + the pixel/tofu assertion so it can't silently regress). In your
`done`, state which approach worked (data-URI embed vs foreignObject), and that you **visually
confirmed the captured image shows real icons via the browser loop** (not just unit tests). Note the
new SHA so firstmate re-pins the dogfood. If Playwright/browser automation is somehow unavailable in
your env, say so explicitly in a `blocked:` line rather than shipping blind again.
