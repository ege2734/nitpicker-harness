// @nitpicker/core — red-box compositing math. Pure, framework-agnostic, and the one fiddly bit worth an
// explicit test: the selection rect is measured in CSS pixels, but html2canvas renders CSS pixels at
// `scale`, so everything drawn onto the captured canvas must be multiplied by that SAME scale (NOT
// re-derived from devicePixelRatio, which may differ from the scale we passed).
import type { Rect } from "./types";

/** Convert a CSS-pixel rect into device-pixel coordinates for an html2canvas render at `scale`. */
export function scaleRect(rect: Rect, scale: number): Rect {
  return { x: rect.x * scale, y: rect.y * scale, w: rect.w * scale, h: rect.h * scale };
}

/**
 * Guard: confirm the captured canvas really is viewport×scale. If html2canvas ignored our scale (or
 * clamped it), the red box would land in the wrong space — return a human-readable warning; else null.
 */
export function checkCaptureScale(
  canvas: { width: number; height: number },
  viewport: { w: number; h: number },
  scale: number,
  tolerancePx = 2,
): string | null {
  const expectedW = Math.round(viewport.w * scale);
  const expectedH = Math.round(viewport.h * scale);
  if (
    Math.abs(canvas.width - expectedW) > tolerancePx ||
    Math.abs(canvas.height - expectedH) > tolerancePx
  ) {
    return (
      `nitpicker: capture-scale mismatch — canvas is ${canvas.width}×${canvas.height}, ` +
      `expected ~${expectedW}×${expectedH} (viewport ${viewport.w}×${viewport.h} @ ${scale}×). ` +
      `Red box / gray bands may be misaligned.`
    );
  }
  return null;
}

export interface RedBoxStyle {
  color?: string;
  /** stroke width in CSS px; scaled up so it reads ~constant regardless of capture scale. */
  lineWidth?: number;
  /** dim color painted over everything OUTSIDE the selection. */
  dim?: string;
}

/**
 * Paint the frozen-frame annotation onto a captured canvas at the correct device-pixel scale: dim
 * everything outside the selection (four bands) and stroke a red rectangle around it. `scale` MUST
 * equal the html2canvas scale used to produce `canvas`.
 */
export function compositeRegion(
  ctx: CanvasRenderingContext2D,
  rectCss: Rect,
  scale: number,
  style: RedBoxStyle = {},
): void {
  const r = scaleRect(rectCss, scale);
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;

  ctx.save();
  // html2canvas draws its content through a residual `ctx.scale(scale, scale)` transform it never
  // resets (html2canvas.js: `ctx.scale(options.scale, options.scale)`). We composite in true
  // device-pixel coordinates, so reset to identity first — otherwise every coordinate below would be
  // multiplied by `scale` a SECOND time and the red box / bands would land at ~2× their position.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Dim outside the selection with four bands.
  ctx.fillStyle = style.dim ?? "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, W, r.y); // top
  ctx.fillRect(0, r.y + r.h, W, H - (r.y + r.h)); // bottom
  ctx.fillRect(0, r.y, r.x, r.h); // left
  ctx.fillRect(r.x + r.w, r.y, W - (r.x + r.w), r.h); // right

  // Red rectangle around the selection.
  ctx.strokeStyle = style.color ?? "#ff3b30";
  ctx.lineWidth = (style.lineWidth ?? 3) * scale;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}
