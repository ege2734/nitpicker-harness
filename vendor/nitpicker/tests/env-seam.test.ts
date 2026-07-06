// The Env seam (harness-local delta — see vendor/nitpicker/README.md). Proves the engine reads the PASSED
// document/window handle rather than the ambient globals, which is what lets the builder shell rasterize
// the same-origin iframe from the parent. html2canvas is stubbed so we can inspect what it was handed.
import { describe, it, expect, vi, beforeEach } from "vitest";

const html2canvas = vi.fn(async () => document.createElement("canvas"));
vi.mock("html2canvas", () => ({ default: html2canvas }));

import { rasterizeViewport } from "../core/region";

beforeEach(() => html2canvas.mockClear());

describe("core/region Env seam", () => {
  it("rasterizes the PASSED env's document.body + window viewport, not the ambient globals", async () => {
    const body = document.createElement("section"); // stand-in for a DIFFERENT document's body
    const env = {
      doc: { body } as unknown as Document,
      win: {
        innerWidth: 812,
        innerHeight: 543,
        scrollX: 11,
        scrollY: 22,
        devicePixelRatio: 2,
      } as unknown as Window,
    };

    await rasterizeViewport(3, document.createElement("div"), env);

    expect(html2canvas).toHaveBeenCalledTimes(1);
    const [el, opts] = html2canvas.mock.calls[0] as unknown as [Element, Record<string, number>];
    expect(el).toBe(body); // the env's body, not document.body
    expect(opts).toMatchObject({ x: 11, y: 22, width: 812, height: 543, scale: 3 });
  });

  it("defaults to the ambient env when none is passed (injected-overlay behavior is unchanged)", async () => {
    await rasterizeViewport(1, document.createElement("div"));

    expect(html2canvas).toHaveBeenCalledTimes(1);
    const [el, opts] = html2canvas.mock.calls[0] as unknown as [Element, Record<string, number>];
    expect(el).toBe(document.body); // ambient default
    expect(opts).toMatchObject({ width: window.innerWidth, height: window.innerHeight, scale: 1 });
  });
});
