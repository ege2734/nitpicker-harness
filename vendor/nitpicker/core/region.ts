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
    // a belt-and-braces guard; a hotkey freeze holder (should never co-occur with a dock raster) is
    // skipped too so it can never bleed into a dock screenshot.
    ignoreElements: (el) =>
      el === hostEl || (el as HTMLElement).dataset?.nitpicker === "frozen",
  });

  const warning = checkCaptureScale(canvas, viewport, scale);
  if (warning) console.warn(warning);

  return { canvas, warning };
}

// ---- hotkey fast-path: cheap DOM-clone freeze at key-press, deferred raster off the critical path ----
//
// The dock path rasters the LIVE DOM at Queue-commit; the hotkey path can't — it must capture *hover-only*
// UI (chart hover-cards, tooltips) that vanish the moment the cursor moves toward a drag. The old hotkey
// path solved this by running html2canvas at key-press, but that is a single ~1–2s SYNCHRONOUS main-thread
// block (the cost is DOM traversal + style computation, not pixel fill) — the viewport froze for the whole
// raster. Instead we snapshot the live viewport into a cheap structural {@link buildFrozenClone} (~one
// frame) at key-press — with targeted mitigations so hover state, <canvas> bitmaps, scroll offset, and form
// state survive — then defer the identical html2canvas raster to drag-end via {@link rasterizeFrozen},
// onto the same Queue-commit + "capturing…" placeholder pipeline the dock path already uses.

/** A key-press-time frozen snapshot of the live viewport: a DOM clone attached (light DOM, so the page's
 *  own stylesheets re-apply) just below the overlay, ready to be rasterized off the critical path. */
export interface FrozenSnapshot {
  /** the attached holder — remove it once {@link rasterizeFrozen} has settled (or on bail). */
  holder: HTMLElement;
  /** the viewport dims the clone was laid out at (app area: viewport − pane). */
  viewport: { w: number; h: number };
  /** resolves once canvas→img replacements have decoded; awaited before the raster for determinism. */
  decode: Promise<unknown>;
}

/** Bake the computed styles of at most a subtree this big — bounds the hover-preserve cost so a hovered
 *  container doesn't drag the whole page into the (expensive) style walk. */
const HOVER_BAKE_CAP = 500;

/**
 * Snapshot the live viewport into a cheap frozen DOM clone at key-press time. Structural `cloneNode(true)`
 * is ~1000× cheaper than an html2canvas raster but loses browser-held state; we re-apply the parts that
 * matter with bounded, targeted work:
 *  - **hover-only UI** — the clone isn't under the pointer, so `:hover` rules don't match; we inline the
 *    computed styles of the currently-hovered component (cap-scoped) so its tooltip/hover-card is frozen;
 *  - **`<canvas>`** — `cloneNode` doesn't copy the bitmap and html2canvas re-clones internally, so we swap
 *    each canvas for an `<img>` of its pixels (tainted cross-origin canvases are left blank — html2canvas'
 *    own CORS limit);
 *  - **scroll offset** — a native-scroll container reproduces page + inner-container scroll WITHOUT a
 *    transform, so `position:fixed`/`sticky` resolve against the viewport exactly as they do live (verified
 *    pixel-identical to a live raster);
 *  - **form state + animations** — form values/checked/selected are copied and animations/transitions are
 *    paused so the frozen visual is truly static.
 * `hostEl` is the overlay's shadow host (it clones as an empty, html2canvas-ignored div). `appWidthCss` is
 * the host app's rendered width (viewport − pane); the clone is laid out at that width so its geometry — and
 * thus the red-box coordinate space — matches the live app.
 */
export function buildFrozenClone(hostEl: Element, appWidthCss: number = window.innerWidth): FrozenSnapshot {
  void hostEl; // the cloned shadow host carries data-html2canvas-ignore, so it's excluded automatically
  const viewport = { w: appWidthCss, h: window.innerHeight };
  const clone = document.body.cloneNode(true) as HTMLElement;

  const decode = freezeCanvases(clone);
  bakeHoverState(clone);
  copyFormState(clone);
  // Capture inner-scroll offsets from the LIVE tree now (before the holder is attached, so the live
  // element collection is exactly the originals); they're re-applied to the clone once it's laid out.
  const scrolls = collectScrollOffsets();

  const holder = document.createElement("div");
  holder.setAttribute("data-nitpicker", "frozen");
  // Pause animations/transitions inside the clone so the snapshot is static, and hide the caret.
  const pause = document.createElement("style");
  pause.textContent =
    `[data-nitpicker="frozen"] *,[data-nitpicker="frozen"] *::before,[data-nitpicker="frozen"] *::after` +
    `{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important;}`;
  holder.appendChild(pause);
  holder.style.cssText =
    `position:fixed;left:0;top:0;width:${viewport.w}px;height:${viewport.h}px;overflow:hidden;` +
    `margin:0;padding:0;border:0;pointer-events:none;z-index:2147483000;` +
    `background:${frozenBackdrop()};`;
  // A native-scroll container replays the page scroll offset without a transform (a transform would break
  // fixed/sticky positioning inside the clone). The clone is laid out at appWidth so its geometry matches
  // the live app — the same coordinate space the selection rect is measured in.
  const scroller = document.createElement("div");
  scroller.style.cssText = `width:${viewport.w}px;height:${viewport.h}px;overflow:hidden;`;
  scroller.appendChild(clone);
  holder.appendChild(scroller);
  document.body.appendChild(holder);
  // scroll offsets must be applied AFTER attach (only a laid-out element scrolls)
  scroller.scrollTop = window.scrollY;
  scroller.scrollLeft = window.scrollX;
  applyScrollOffsets(clone, scrolls);

  return { holder, viewport, decode };
}

/** Rasterize a {@link buildFrozenClone} holder into a raw viewport canvas — the deferred, off-key-press
 *  counterpart of {@link rasterizeViewport}, producing the same appWidth×viewport canvas the red-box
 *  compositor expects. html2canvas snapshots the holder synchronously into its own clone at call time, so
 *  the caller may detach the holder as soon as this settles. */
export async function rasterizeFrozen(snapshot: FrozenSnapshot, scale: number): Promise<RasterResult> {
  const { default: html2canvas } = await import("html2canvas");
  await snapshot.decode; // ensure canvas→img replacements have decoded before we paint
  const { holder, viewport } = snapshot;
  const canvas = await html2canvas(holder, {
    x: 0,
    y: 0,
    width: viewport.w,
    height: viewport.h,
    scale,
    useCORS: true,
    backgroundColor: null,
    logging: false,
  });

  const warning = checkCaptureScale(canvas, viewport, scale);
  if (warning) console.warn(warning);

  return { canvas, warning };
}

/** A solid backdrop for the frozen holder: the page's own body/root background where it's opaque, else
 *  white — so a frozen page with a dark theme doesn't flash white behind transparent gaps. */
function frozenBackdrop(): string {
  for (const el of [document.body, document.documentElement]) {
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== "transparent" && !bg.startsWith("rgba(0, 0, 0, 0")) return bg;
  }
  return "#ffffff";
}

/** Replace each `<canvas>` in the clone with an `<img>` of its current pixels (`cloneNode` blanks canvases
 *  and html2canvas re-clones internally, so an in-place pixel copy is lost). Cross-origin-tainted canvases
 *  throw on `toDataURL` and are left blank — the same limit html2canvas has. Returns a promise that settles
 *  once the replacement images decode. Live↔clone canvases match by document order (cloneNode preserves it). */
function freezeCanvases(clone: HTMLElement): Promise<unknown> {
  const live = Array.from(document.body.querySelectorAll("canvas"));
  const cloned = Array.from(clone.querySelectorAll("canvas"));
  const decodes: Promise<unknown>[] = [];
  for (let i = 0; i < live.length && i < cloned.length; i++) {
    try {
      const url = live[i].toDataURL("image/png");
      const img = new Image();
      img.width = live[i].width;
      img.height = live[i].height;
      const style = cloned[i].getAttribute("style");
      if (style) img.setAttribute("style", style);
      img.src = url;
      cloned[i].replaceWith(img);
      decodes.push(img.decode().catch(() => undefined));
    } catch {
      /* tainted (cross-origin) canvas — leave the blank clone canvas, matching html2canvas' CORS limit */
    }
  }
  return Promise.all(decodes);
}

/** Freeze CSS `:hover`-only UI into the clone. The detached clone isn't under the pointer, so `:hover`
 *  rules won't match; we inline the computed styles of the hovered component so its tooltip/hover-card is
 *  baked in. `querySelectorAll(':hover')` returns the whole ancestor chain (shallow→deep); we bake the
 *  shallowest hovered element whose subtree is ≤ {@link HOVER_BAKE_CAP} nodes, which covers a descendant
 *  rule (`.card:hover .tip`) at bounded cost. Portaled or sibling-combinator hover effects outside that
 *  subtree aren't frozen (documented limitation). No-op when nothing is hovered. */
function bakeHoverState(clone: HTMLElement): void {
  let chain: Element[];
  try {
    chain = Array.from(document.querySelectorAll(":hover")).filter(
      (e) => e !== document.documentElement && e !== document.body,
    );
  } catch {
    return; // :hover unsupported (e.g. jsdom) — nothing to bake
  }
  let root: Element | null = null;
  for (const e of chain) {
    if (e.querySelectorAll("*").length + 1 <= HOVER_BAKE_CAP) {
      root = e;
      break;
    }
  }
  if (!root) return;
  const target = locateInClone(clone, root);
  if (!target) return;
  const src = [root, ...Array.from(root.querySelectorAll("*"))];
  const dst = [target, ...Array.from(target.querySelectorAll("*"))];
  for (let i = 0; i < src.length && i < dst.length; i++) {
    const cs = getComputedStyle(src[i]);
    let css = "";
    for (let j = 0; j < cs.length; j++) css += `${cs[j]}:${cs.getPropertyValue(cs[j])};`;
    (dst[i] as HTMLElement).setAttribute("style", css);
  }
}

/** Map a live element to its clone counterpart by walking the same child-index path from `document.body`.
 *  Relies on the clone being a structural copy of body (indices line up, including the ignored shadow host). */
function locateInClone(cloneBody: HTMLElement, liveEl: Element): Element | null {
  const path: number[] = [];
  let n: Element | null = liveEl;
  while (n && n !== document.body) {
    const parent: Element | null = n.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, n));
    n = parent;
  }
  let cn: Element = cloneBody;
  for (const idx of path) {
    const next = cn.children[idx];
    if (!next) return null;
    cn = next;
  }
  return cn;
}

/** Copy live form-control state into the clone — `cloneNode` is spec-inconsistent for `checkbox.checked`,
 *  `select`, and (some browsers) `input.value`. Bounded to form controls, matched by document order. */
function copyFormState(clone: HTMLElement): void {
  const live = Array.from(document.body.querySelectorAll("input, textarea, select"));
  const cloned = Array.from(clone.querySelectorAll("input, textarea, select"));
  for (let i = 0; i < live.length && i < cloned.length; i++) {
    const l = live[i];
    const c = cloned[i];
    try {
      if (l.tagName === "SELECT") {
        (c as HTMLSelectElement).selectedIndex = (l as HTMLSelectElement).selectedIndex;
      } else if (l.tagName === "TEXTAREA") {
        const v = (l as HTMLTextAreaElement).value;
        c.textContent = v;
        (c as HTMLTextAreaElement).value = v;
      } else {
        const li = l as HTMLInputElement;
        const ci = c as HTMLInputElement;
        if (li.type === "checkbox" || li.type === "radio") {
          if (li.checked) ci.setAttribute("checked", "");
          else ci.removeAttribute("checked");
          ci.checked = li.checked;
        } else {
          ci.setAttribute("value", li.value);
          ci.value = li.value;
        }
      }
    } catch {
      /* exotic control — skip */
    }
  }
}

/** Record the document-order index + offset of every scrolled inner container in the LIVE tree. Reading
 *  `scrollTop` is a cheap layout property (no style resolution); we only keep the ones actually scrolled. */
function collectScrollOffsets(): Array<{ i: number; top: number; left: number }> {
  const live = document.body.getElementsByTagName("*");
  const out: Array<{ i: number; top: number; left: number }> = [];
  for (let i = 0; i < live.length; i++) {
    const l = live[i] as HTMLElement;
    if (l.scrollTop || l.scrollLeft) out.push({ i, top: l.scrollTop, left: l.scrollLeft });
  }
  return out;
}

/** Re-apply recorded scroll offsets to the clone (a structural clone resets `scrollTop`/`Left` to 0). Must
 *  run after the clone is attached + laid out. Indices line up because the clone is a structural copy. */
function applyScrollOffsets(clone: HTMLElement, scrolls: Array<{ i: number; top: number; left: number }>): void {
  const cloned = clone.getElementsByTagName("*");
  for (const { i, top, left } of scrolls) {
    const c = cloned[i] as HTMLElement | undefined;
    if (c) {
      c.scrollTop = top;
      c.scrollLeft = left;
    }
  }
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
