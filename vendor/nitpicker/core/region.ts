// @nitpicker/core — region capture. On mouse-up we freeze the view, rasterize the whole viewport with
// html2canvas, then composite the gray-dim + red-box annotation onto the captured canvas at the correct
// device-pixel scale. html2canvas is imported dynamically so it is only ever pulled into the bundle
// inside this dev-only path (and thus tree-shaken from any prod build).
import { compositeRegion, checkCaptureScale } from "./redbox";
import { ambientEnv, type Env } from "./env";
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
 *
 * `env` selects which document/window to rasterize (default: ambient). The builder shell passes the
 * proxied iframe's env so html2canvas snapshots the iframe content from the parent shell.
 */
export async function rasterizeViewport(
  scale: number,
  hostEl: Element,
  env: Env = ambientEnv(),
): Promise<RasterResult> {
  const { default: html2canvas } = await import("html2canvas-pro");
  const { doc, win } = env;
  const viewport = { w: win.innerWidth, h: win.innerHeight };

  const canvas = await html2canvas(doc.body, {
    x: win.scrollX,
    y: win.scrollY,
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
export function buildFrozenClone(
  hostEl: Element,
  appWidthCss?: number,
  env: Env = ambientEnv(),
): FrozenSnapshot {
  void hostEl; // the cloned shadow host carries data-html2canvas-ignore, so it's excluded automatically
  const { doc, win } = env;
  const viewport = { w: appWidthCss ?? win.innerWidth, h: win.innerHeight };
  const clone = doc.body.cloneNode(true) as HTMLElement;

  // Pair each scrolled LIVE element to its CLONE counterpart NOW, while the clone is still a pristine
  // structural copy — before freezeCanvases() swaps each <canvas> for a childless <img> (dropping any
  // canvas fallback children), which would desync a flat live-vs-clone index mapping for everything after
  // it. We keep direct clone references, so the mapping survives that mutation; offsets are applied after
  // layout. bakeHoverState/copyFormState also assume matching doc order, so run them before the swap too.
  const scrolls = collectScrollOffsets(clone, env);
  bakeHoverState(clone, env);
  copyFormState(clone, env);
  // Structure-mutating canvas swap runs LAST, so the doc-order-dependent passes above see an intact clone.
  const decode = freezeCanvases(clone, env);
  // A prior capture's frozen holder can still be attached to the live body (its deferred raster hasn't
  // settled and the card is closed, so the np-show guard doesn't block a second hotkey press) and was
  // deep-cloned above. Being position:fixed + opaque, left nested it would repaint the whole app in this
  // fresh clone (and its deferred raster) with the stale prior snapshot. Strip it now — AFTER the doc-order
  // pairing passes above, which ran against the still-identical live/clone trees so their alignment held;
  // any stored clone reference that falls inside the removed subtree is simply never applied.
  clone.querySelectorAll('[data-nitpicker="frozen"]').forEach((n) => n.remove());

  const holder = doc.createElement("div");
  holder.setAttribute("data-nitpicker", "frozen");
  // Pause animations/transitions inside the clone so the snapshot is static, and hide the caret.
  const pause = doc.createElement("style");
  pause.textContent =
    `[data-nitpicker="frozen"] *,[data-nitpicker="frozen"] *::before,[data-nitpicker="frozen"] *::after` +
    `{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important;}`;
  holder.appendChild(pause);
  // `pointer-events:auto` makes the holder a click barrier for its whole lifetime: whenever the frozen
  // snapshot is shown it swallows clicks so they can't reach the invisible live page behind it — including
  // the post-Queue raster window after the card + its np-backdrop are gone. While the card is open (or a
  // drag is armed) the shadow-DOM layers sit above this holder (z 2147483647 > 2147483000) and still get
  // those interactions first; the holder only catches clicks once those higher layers are removed.
  holder.style.cssText =
    `position:fixed;left:0;top:0;width:${viewport.w}px;height:${viewport.h}px;overflow:hidden;` +
    `margin:0;padding:0;border:0;pointer-events:auto;z-index:2147483000;` +
    `background:${frozenBackdrop(env)};`;
  // A native-scroll container replays the page scroll offset without a transform (a transform would break
  // fixed/sticky positioning inside the clone). The clone is laid out at appWidth so its geometry matches
  // the live app — the same coordinate space the selection rect is measured in.
  const scroller = doc.createElement("div");
  scroller.style.cssText = `width:${viewport.w}px;height:${viewport.h}px;overflow:hidden;`;
  scroller.appendChild(clone);
  holder.appendChild(scroller);
  doc.body.appendChild(holder);
  // scroll offsets must be applied AFTER attach (only a laid-out element scrolls)
  scroller.scrollTop = win.scrollY;
  scroller.scrollLeft = win.scrollX;
  applyScrollOffsets(scrolls);

  return { holder, viewport, decode };
}

/** Rasterize a {@link buildFrozenClone} holder into a raw viewport canvas — the deferred, off-key-press
 *  counterpart of {@link rasterizeViewport}, producing the same appWidth×viewport canvas the red-box
 *  compositor expects. html2canvas snapshots the holder synchronously into its own clone at call time, so
 *  the caller may detach the holder as soon as this settles. */
export async function rasterizeFrozen(snapshot: FrozenSnapshot, scale: number): Promise<RasterResult> {
  const { default: html2canvas } = await import("html2canvas-pro");
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
function frozenBackdrop(env: Env): string {
  const { doc, win } = env;
  for (const el of [doc.body, doc.documentElement]) {
    const bg = win.getComputedStyle(el).backgroundColor;
    if (bg && !isFullyTransparent(bg)) return bg;
  }
  return "#ffffff";
}

/** True only when a computed background color paints nothing: the keyword `transparent`, or an rgb/rgba
 *  whose alpha channel is exactly 0. A semi-transparent color (e.g. `rgba(0, 0, 0, 0.6)`) is NOT transparent
 *  — it must be treated as an opaque-enough backdrop, not fall through to white. */
function isFullyTransparent(bg: string): boolean {
  if (bg === "transparent") return true;
  const m = bg.match(/^rgba?\(([^)]*)\)$/);
  if (!m) return false;
  const parts = m[1].split(",").map((s) => s.trim());
  if (parts.length < 4) return false; // rgb() has no alpha → opaque
  return parseFloat(parts[3]) === 0;
}

/** Replace each `<canvas>` in the clone with an `<img>` of its current pixels (`cloneNode` blanks canvases
 *  and html2canvas re-clones internally, so an in-place pixel copy is lost). Cross-origin-tainted canvases
 *  throw on `toDataURL` and are left blank — the same limit html2canvas has. The `<img>` intrinsic size stays
 *  the backing-store pixels, but the DISPLAYED box is pinned to the live canvas's rendered rect so a canvas
 *  sized by CSS class/stylesheet (whose rules no longer match an `<img>`) isn't drawn at its raw bitmap size.
 *  Returns a promise that settles once the replacement images decode. Live↔clone canvases match by document
 *  order (cloneNode preserves it). */
function freezeCanvases(clone: HTMLElement, env: Env): Promise<unknown> {
  const live = Array.from(env.doc.body.querySelectorAll("canvas"));
  const cloned = Array.from(clone.querySelectorAll("canvas"));
  const decodes: Promise<unknown>[] = [];
  for (let i = 0; i < live.length && i < cloned.length; i++) {
    try {
      const url = live[i].toDataURL("image/png");
      const img = env.doc.createElement("img");
      img.width = live[i].width;
      img.height = live[i].height;
      const style = cloned[i].getAttribute("style");
      if (style) img.setAttribute("style", style);
      const rect = live[i].getBoundingClientRect();
      img.style.width = `${rect.width}px`;
      img.style.height = `${rect.height}px`;
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
function bakeHoverState(clone: HTMLElement, env: Env): void {
  const { doc, win } = env;
  let chain: Element[];
  try {
    chain = Array.from(doc.querySelectorAll(":hover")).filter(
      (e) => e !== doc.documentElement && e !== doc.body,
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
  const target = locateInClone(clone, root, env);
  if (!target) return;
  const src = [root, ...Array.from(root.querySelectorAll("*"))];
  const dst = [target, ...Array.from(target.querySelectorAll("*"))];
  for (let i = 0; i < src.length && i < dst.length; i++) {
    const cs = win.getComputedStyle(src[i]);
    let css = "";
    for (let j = 0; j < cs.length; j++) css += `${cs[j]}:${cs.getPropertyValue(cs[j])};`;
    (dst[i] as HTMLElement).setAttribute("style", css);
  }
}

/** Map a live element to its clone counterpart by walking the same child-index path from `document.body`.
 *  Relies on the clone being a structural copy of body (indices line up, including the ignored shadow host). */
function locateInClone(cloneBody: HTMLElement, liveEl: Element, env: Env): Element | null {
  const path: number[] = [];
  let n: Element | null = liveEl;
  while (n && n !== env.doc.body) {
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
function copyFormState(clone: HTMLElement, env: Env): void {
  const live = Array.from(env.doc.body.querySelectorAll("input, textarea, select"));
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

/** Record the scroll offset of every scrolled inner container in the LIVE tree, paired to a DIRECT reference
 *  to its CLONE counterpart. Must be called while `clone` is still a pristine structural copy of the live
 *  body (same element count + order), so the flat live↔clone index walk lines up; storing element references
 *  (not integer indices) then keeps the pairing valid across later clone mutations like freezeCanvases (which
 *  drops canvas fallback children and would otherwise shift every subsequent index). Reading `scrollTop` is a
 *  cheap layout property (no style resolution); we only keep the ones actually scrolled. */
function collectScrollOffsets(
  clone: HTMLElement,
  env: Env,
): Array<{ el: HTMLElement; top: number; left: number }> {
  const live = env.doc.body.getElementsByTagName("*");
  const cloned = clone.getElementsByTagName("*");
  const out: Array<{ el: HTMLElement; top: number; left: number }> = [];
  for (let i = 0; i < live.length && i < cloned.length; i++) {
    const l = live[i] as HTMLElement;
    if (l.scrollTop || l.scrollLeft) {
      out.push({ el: cloned[i] as HTMLElement, top: l.scrollTop, left: l.scrollLeft });
    }
  }
  return out;
}

/** Re-apply recorded scroll offsets to the clone (a structural clone resets `scrollTop`/`Left` to 0), via the
 *  clone element references captured in {@link collectScrollOffsets}. Must run after the clone is attached +
 *  laid out (only a laid-out element scrolls). */
function applyScrollOffsets(scrolls: Array<{ el: HTMLElement; top: number; left: number }>): void {
  for (const { el, top, left } of scrolls) {
    el.scrollTop = top;
    el.scrollLeft = left;
  }
}

/** Trim a captured canvas to the left `appWidthCss` CSS px (× scale in device px), dropping the docked
 *  pane's reserved gutter on the right. A no-op when `appWidthCss` already covers the whole canvas. The
 *  red box + dim bands live within the app area (selection is clamped there), so this never touches them. */
function cropToAppWidth(
  canvas: HTMLCanvasElement,
  appWidthCss: number,
  scale: number,
  env: Env,
): HTMLCanvasElement {
  const targetW = Math.round(appWidthCss * scale);
  if (targetW >= canvas.width) return canvas;
  const out = env.doc.createElement("canvas");
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
  appWidthCss?: number,
  env: Env = ambientEnv(),
): Promise<{ blob: Blob; thumb: string }> {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("nitpicker: could not get 2d context for composite");
  compositeRegion(ctx, selCss, scale);

  const out = cropToAppWidth(canvas, appWidthCss ?? env.win.innerWidth, scale, env);
  const blob = await new Promise<Blob>((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new Error("nitpicker: toBlob failed"))), "image/png");
  });

  return { blob, thumb: makeThumb(out, undefined, env) };
}

/**
 * Capture the current viewport, burn in the gray-dim + red box around `selCss`, drop the docked pane's
 * gutter, and return the annotated canvas + a PNG blob. Used by the dock path, which rasterizes at
 * Queue-commit time; the hotkey path instead builds a cheap DOM clone via {@link buildFrozenClone} at
 * key-press and defers the raster to Queue-commit via {@link rasterizeFrozen} + {@link annotateRegion}.
 * `appWidth` is the host app's rendered width (viewport − pane).
 */
export async function captureRegion(
  selCss: Rect,
  scale: number,
  hostEl: Element,
  appWidth?: number,
  env: Env = ambientEnv(),
): Promise<CaptureResult> {
  const { canvas, warning } = await rasterizeViewport(scale, hostEl, env);
  const { blob, thumb } = await annotateRegion(canvas, selCss, scale, appWidth ?? env.win.innerWidth, env);
  return { blob, canvas, thumb, warning };
}

/** Downscale the composited canvas into a tiny data URL for the panel snippet card. */
function makeThumb(canvas: HTMLCanvasElement, maxW = 160, env: Env = ambientEnv()): string {
  const ratio = canvas.height / canvas.width;
  const t = env.doc.createElement("canvas");
  t.width = maxW;
  t.height = Math.round(maxW * ratio);
  const tctx = t.getContext("2d");
  if (tctx) tctx.drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL("image/png");
}
