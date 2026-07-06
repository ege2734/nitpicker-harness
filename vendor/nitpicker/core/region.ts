// @nitpicker/core — region capture. On mouse-up we freeze the view, rasterize the whole viewport with
// html2canvas, then composite the gray-dim + red-box annotation onto the captured canvas at the correct
// device-pixel scale. html2canvas is imported dynamically so it is only ever pulled into the bundle
// inside this dev-only path (and thus tree-shaken from any prod build).
import { compositeRegion, checkCaptureScale } from "./redbox";
import type { Rect } from "./types";

export interface CaptureResult {
  blob: Blob;
  /** the composited frozen canvas, shown on top to freeze the view. */
  canvas: HTMLCanvasElement;
  /** small data-URL thumbnail for the chat panel. */
  thumb: string;
  /** scale-check warning, if any. */
  warning: string | null;
}

export interface RasterResult {
  /** the raw, un-annotated viewport canvas. */
  canvas: HTMLCanvasElement;
  /** scale-check warning, if any. */
  warning: string | null;
}

/**
 * Rasterize the current viewport into a raw (un-annotated) canvas with html2canvas. Split out from
 * {@link captureRegion} so the Cmd/Ctrl+Shift+X fast-path can freeze the viewport at *key-press time* —
 * preserving hover-only UI (chart hover-cards, tooltips, menus that vanish on mouse-move) — before the
 * user moves the cursor to drag a selection box. `hostEl` is the overlay's own shadow host, excluded
 * from the capture so our UI (dock, docked pane) never appears in the screenshot.
 *
 * This rasterizes the FULL viewport and composites the red box in full-viewport coordinates — the same
 * coordinate space the selection is measured in — so the box always frames exactly what the user drew.
 * Excluding the docked pane's gutter is done as a final left-crop in {@link annotateRegion} (NOT by
 * shrinking the raster here), so the sensitive box/band math never has to be remapped into a narrower
 * space. That remapping is what previously mispositioned the red box.
 */
export async function rasterizeViewport(scale: number, hostEl: Element): Promise<RasterResult> {
  const { default: html2canvas } = await import("html2canvas");
  const viewport = { w: window.innerWidth, h: window.innerHeight };

  const canvas = await html2canvas(document.body, {
    x: window.scrollX,
    y: window.scrollY,
    width: viewport.w,
    height: viewport.h,
    scale,
    useCORS: true,
    backgroundColor: null,
    logging: false,
    // Exclude our overlay UI from the raster. The shadow host also carries data-html2canvas-ignore as
    // a belt-and-braces guard.
    ignoreElements: (el) => el === hostEl,
  });

  const warning = checkCaptureScale(canvas, viewport, scale);
  if (warning) console.warn(warning);

  return { canvas, warning };
}

/** Trim a captured canvas to the left `appWidthCss` CSS px (× scale in device px), dropping the docked
 *  pane's reserved gutter on the right. A no-op when `appWidthCss` already covers the whole canvas. The
 *  red box + dim bands live within the app area (selection is clamped there), so this never touches them. */
function cropToAppWidth(
  canvas: HTMLCanvasElement,
  appWidthCss: number,
  scale: number,
): HTMLCanvasElement {
  const targetW = Math.round(appWidthCss * scale);
  if (targetW >= canvas.width) return canvas;
  const out = document.createElement("canvas");
  out.width = targetW;
  out.height = canvas.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("nitpicker: could not get 2d context for pane crop");
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/**
 * Burn the gray-dim + red box around `selCss` into an already-rasterized (full-viewport) `canvas` in
 * place, then crop the docked pane's gutter off the right (to `appWidthCss` CSS px) and return the PNG
 * blob + thumbnail of that cropped result. `scale` MUST equal the scale the canvas was rasterized at.
 * The compositing happens in full-viewport space (matching the selection), and the crop only trims the
 * right edge, so the red box is never shifted. `appWidthCss` defaults to the full viewport (no crop).
 */
export async function annotateRegion(
  canvas: HTMLCanvasElement,
  selCss: Rect,
  scale: number,
  appWidthCss: number = window.innerWidth,
): Promise<{ blob: Blob; thumb: string }> {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("nitpicker: could not get 2d context for composite");
  compositeRegion(ctx, selCss, scale);

  const out = cropToAppWidth(canvas, appWidthCss, scale);
  const blob = await new Promise<Blob>((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new Error("nitpicker: toBlob failed"))), "image/png");
  });

  return { blob, thumb: makeThumb(out) };
}

/**
 * Capture the current viewport, burn in the gray-dim + red box around `selCss`, drop the docked pane's
 * gutter, and return the annotated canvas + a PNG blob. Used by the dock path, which rasterizes at
 * Queue-commit time; the hotkey path instead calls {@link rasterizeViewport} at key-press and
 * {@link annotateRegion} on mouse-up. `appWidth` is the host app's rendered width (viewport − pane).
 */
export async function captureRegion(
  selCss: Rect,
  scale: number,
  hostEl: Element,
  appWidth: number = window.innerWidth,
): Promise<CaptureResult> {
  const { canvas, warning } = await rasterizeViewport(scale, hostEl);
  const { blob, thumb } = await annotateRegion(canvas, selCss, scale, appWidth);
  return { blob, canvas, thumb, warning };
}

/** Downscale the composited canvas into a tiny data URL for the panel snippet card. */
function makeThumb(canvas: HTMLCanvasElement, maxW = 160): string {
  const ratio = canvas.height / canvas.width;
  const t = document.createElement("canvas");
  t.width = maxW;
  t.height = Math.round(maxW * ratio);
  const tctx = t.getContext("2d");
  if (tctx) tctx.drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL("image/png");
}
