// @vitest-environment node
// Builder-shell Phase 2 geometry — the §5 single-offset rule that keeps the parent highlight / red box
// exactly over the iframe content. These pins are the regression guard for the "double-offset" bug: the
// iframe's offset must be applied EXACTLY ONCE going each direction.
import { describe, it, expect } from "vitest";
import { dragBox, elementRectInParent, parentPointToIframe } from "../src/shell/geometry";

describe("shell geometry (§5 single-offset rule)", () => {
  const frame = { left: 120, top: 40 };

  it("places an iframe-content element rect into the parent by adding the frame offset once", () => {
    const elRect = { left: 30, top: 50, width: 200, height: 80 };
    expect(elementRectInParent(elRect, frame)).toEqual({
      left: 150, // 120 + 30, ONCE
      top: 90, // 40 + 50, ONCE
      width: 200,
      height: 80,
    });
  });

  it("does NOT double-count the frame offset (the bug this guards)", () => {
    // A content element flush to the iframe's top-left must land at the frame's top-left — not 2× offset.
    const box = elementRectInParent({ left: 0, top: 0, width: 10, height: 10 }, frame);
    expect(box.left).toBe(120); // not 240
    expect(box.top).toBe(40); // not 80
  });

  it("converts a parent point into iframe-content coords by subtracting the frame offset once", () => {
    expect(parentPointToIframe(150, 90, frame)).toEqual({ x: 30, y: 50 });
  });

  it("round-trips a content rect → parent point → content point", () => {
    const elRect = { left: 30, top: 50, width: 0, height: 0 };
    const parent = elementRectInParent(elRect, frame);
    expect(parentPointToIframe(parent.left, parent.top, frame)).toEqual({ x: 30, y: 50 });
  });

  it("tracks a scrolled iframe: getBoundingClientRect already reflects scroll, so placement just re-adds the fixed offset", () => {
    // element scrolled partly above the iframe viewport top → negative content-top
    const scrolled = { left: 30, top: -120, width: 200, height: 80 };
    expect(elementRectInParent(scrolled, frame)).toEqual({ left: 150, top: -80, width: 200, height: 80 });
  });

  it("normalizes drag corners into a positive box regardless of direction", () => {
    expect(dragBox(200, 300, 100, 150)).toEqual({ left: 100, top: 150, width: 100, height: 150 });
    expect(dragBox(100, 150, 200, 300)).toEqual({ left: 100, top: 150, width: 100, height: 150 });
  });
});
