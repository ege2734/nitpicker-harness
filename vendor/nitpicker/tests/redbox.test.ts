// nitpicker — red-box compositing math. The one fiddly bit: the selection is measured in CSS px but
// html2canvas renders at `scale`, so everything drawn onto the captured canvas must be multiplied by
// that SAME scale. These tests pin that multiply and the scale-mismatch guard.
import { describe, it, expect } from "vitest";
import { scaleRect, checkCaptureScale, compositeRegion } from "../core/redbox";

describe("scaleRect", () => {
  it("multiplies CSS px by the html2canvas scale", () => {
    expect(scaleRect({ x: 100, y: 50, w: 200, h: 100 }, 2)).toEqual({
      x: 200,
      y: 100,
      w: 400,
      h: 200,
    });
  });
  it("is identity at scale 1", () => {
    const r = { x: 12, y: 34, w: 56, h: 78 };
    expect(scaleRect(r, 1)).toEqual(r);
  });
  it("handles fractional dpr (e.g. 1.5)", () => {
    expect(scaleRect({ x: 10, y: 20, w: 30, h: 40 }, 1.5)).toEqual({ x: 15, y: 30, w: 45, h: 60 });
  });
});

describe("checkCaptureScale", () => {
  it("passes when the canvas is viewport×scale", () => {
    expect(checkCaptureScale({ width: 800, height: 600 }, { w: 400, h: 300 }, 2)).toBeNull();
  });
  it("warns when html2canvas ignored the requested scale", () => {
    const warning = checkCaptureScale({ width: 400, height: 300 }, { w: 400, h: 300 }, 2);
    expect(warning).toMatch(/capture-scale mismatch/);
  });
  it("tolerates a 1px rounding wobble", () => {
    expect(checkCaptureScale({ width: 801, height: 599 }, { w: 400, h: 300 }, 2)).toBeNull();
  });
});

describe("compositeRegion", () => {
  // Record the draw calls against a fake 2d context so we can assert exact device-pixel coordinates.
  function fakeCtx(width: number, height: number) {
    const calls: {
      fill: number[][];
      stroke: number[][];
      lineWidth: number[];
      setTransform: number[][];
    } = { fill: [], stroke: [], lineWidth: [], setTransform: [] };
    const ctx = {
      canvas: { width, height },
      save() {},
      restore() {},
      setTransform: (...m: number[]) => calls.setTransform.push(m),
      set lineWidth(v: number) {
        calls.lineWidth.push(v);
      },
      fillStyle: "",
      strokeStyle: "",
      fillRect: (x: number, y: number, w: number, h: number) => calls.fill.push([x, y, w, h]),
      strokeRect: (x: number, y: number, w: number, h: number) => calls.stroke.push([x, y, w, h]),
    } as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  }

  it("draws four dim bands + a red box in device-pixel coords at scale 2", () => {
    const { ctx, calls } = fakeCtx(800, 600); // viewport 400×300 @2
    compositeRegion(ctx, { x: 100, y: 50, w: 200, h: 100 }, 2);

    // must reset html2canvas's residual scale() transform to identity before drawing device px
    expect(calls.setTransform).toEqual([[1, 0, 0, 1, 0, 0]]);
    // selection in device px = {200,100,400,200}; canvas 800×600
    expect(calls.stroke).toEqual([[200, 100, 400, 200]]);
    expect(calls.lineWidth).toEqual([6]); // 3 CSS px × scale 2
    expect(calls.fill).toEqual([
      [0, 0, 800, 100], // top
      [0, 300, 800, 300], // bottom
      [0, 100, 200, 200], // left
      [600, 100, 200, 200], // right
    ]);
  });

  it("keeps the red box aligned with the dim hole at scale 1", () => {
    const { ctx, calls } = fakeCtx(400, 300);
    compositeRegion(ctx, { x: 40, y: 30, w: 100, h: 60 }, 1);
    const [sx, sy, sw, sh] = calls.stroke[0];
    // the left/top/right/bottom bands must exactly frame the strokeRect
    expect([sx, sy, sw, sh]).toEqual([40, 30, 100, 60]);
    expect(calls.fill[0]).toEqual([0, 0, 400, 30]); // top band ends where the box starts
  });
});
