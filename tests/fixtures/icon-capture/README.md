# icon-capture — browser repro for the region-capture icon-font fix

Reproduces (and lets you re-verify) the bug where region-capture screenshots rendered every icon-font glyph
as a tofu box (□) while the live app was fine. Root cause: html2canvas draws text with the **ambient**
document's fonts, but the builder/shell path rasterizes a **different** document — the proxied `<iframe>` via
the `Env` seam — so a self-hosted icon webfont (`@font-face`, PUA glyphs, e.g. `@loom/ds`'s Phosphor font)
declared only in the iframe was never in the drawing document. The fix (`embedFontsForCapture` in
`vendor/nitpicker/core/region.ts`) reads the source document's `@font-face` rules, fetches the bytes, and
`FontFace`-loads them into the drawing document **before** rasterizing. Guarded by
`vendor/nitpicker/tests/region-fontembed.test.ts`; visually verified with this fixture.

## Files
- `make-font.py` — synthesizes `iconfont.woff2`: a tiny icon web font with **solid** glyphs at PUA codepoints
  U+E000..U+E005 (so a rendered glyph is a filled shape; a missing glyph is the browser's hollow tofu box —
  easy to tell apart). Regenerate: `python3 make-font.py` (needs `pip install fonttools brotli`).
- `index.html` — the icon toolbar (Fork/Share/Deploy/Preview/Code/Plugins), `@font-face` self-hosted.
- `index-iframe.html` — the **repro**: a parent page (NO icon font) embedding `index.html` in an `<iframe>`,
  mirroring the harness builder/shell (capture the iframe's doc from the parent).
- `probe.ts` → `probe.js` — exposes `window.__nhRaster()` (same-document) and `window.__nhRasterIframe()`
  (cross-document) which run the REAL `rasterizeViewport` and return a PNG data URL. Rebuild:
  `npx esbuild tests/fixtures/icon-capture/probe.ts --bundle --format=iife --platform=browser --outfile=tests/fixtures/icon-capture/probe.js`

## Re-run the visual loop
```
python3 -m http.server 8199 --directory tests/fixtures/icon-capture   # serve
# drive with any browser automation: navigate http://127.0.0.1:8199/index-iframe.html,
# await the iframe + document.fonts.ready, then: await window.__nhRasterIframe(2)
# decode the returned data: URL to a PNG and LOOK — icons must be solid shapes, not □ boxes.
```
`probe.js` is a build artifact (gitignored).
