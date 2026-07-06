// nitpicker-harness — builder-shell Phase 2 geometry. PURE + unit-tested (tests/shell-geometry.test.ts).
//
// The interaction layer lives in the PARENT shell but reads the same-origin `<iframe>`'s content. Two
// coordinate spaces are in play:
//   • iframe-content viewport coords — what `element.getBoundingClientRect()` returns INSIDE the iframe,
//     and the space the region red-box + html2canvas raster are measured in (origin = iframe's top-left).
//   • parent viewport coords — what the parent's mouse events report and where the highlight / drag box
//     render (fixed-positioned in the shell window).
//
// The one rule that matters (viability-report §5 / the "double-offset" trap): translate between the two by
// the iframe's OWN offset in the parent (`frame.getBoundingClientRect()`) EXACTLY ONCE. Add it going
// content→parent (highlight placement); subtract it going parent→content (drag point → capture rect).
// Applying it twice — e.g. positioning the highlight inside an already-offset stage element AND adding the
// frame offset — is the bug this module (and its test) pins shut: render fixed in the parent viewport and
// add the offset a single time.

/** Just the fields we need off a rect (a DOMRect satisfies this). */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The iframe's offset in the parent viewport (its `getBoundingClientRect()`); only the corner is used. */
export interface FrameOffset {
  left: number;
  top: number;
}

/** A fixed-position box in parent-viewport coords, ready to write onto an overlay element's style. */
export interface ParentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Place an iframe-content element rect into the PARENT viewport for a fixed-position highlight: add the
 * iframe's offset ONCE. `elRect` is the element's `getBoundingClientRect()` read inside the iframe (so it
 * already tracks the iframe's own scroll); `frame` is the iframe element's rect in the parent.
 */
export function elementRectInParent(elRect: RectLike, frame: FrameOffset): ParentBox {
  return {
    left: frame.left + elRect.left,
    top: frame.top + elRect.top,
    width: elRect.width,
    height: elRect.height,
  };
}

/** Convert a parent-viewport point (a shell mouse event) into iframe-content viewport coords: subtract the
 *  iframe's offset ONCE. This is the space the region capture rect + red box are measured in. */
export function parentPointToIframe(
  px: number,
  py: number,
  frame: FrameOffset,
): { x: number; y: number } {
  return { x: px - frame.left, y: py - frame.top };
}

/** Normalize two parent-viewport drag corners into a positive-size box (for the drag outline). */
export function dragBox(x0: number, y0: number, x1: number, y1: number): ParentBox {
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}
