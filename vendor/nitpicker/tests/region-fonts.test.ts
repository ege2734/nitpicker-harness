// Harness-local delta (see vendor/nitpicker/README.md): rasterizeViewport pre-warms the document's webfonts
// before html2canvas rasterizes, so self-hosted icon fonts (e.g. @loom/ds's Phosphor font) don't capture as
// missing-glyph tofu boxes. html2canvas-pro is stubbed so we only observe the font pre-warm.
import { describe, it, expect, vi, beforeEach } from "vitest";

const html2canvas = vi.fn(async () => document.createElement("canvas"));
vi.mock("html2canvas-pro", () => ({ default: html2canvas }));

import { rasterizeViewport } from "../core/region";

beforeEach(() => html2canvas.mockClear());

function fakeWin() {
  return { innerWidth: 100, innerHeight: 100, scrollX: 0, scrollY: 0, devicePixelRatio: 1 } as unknown as Window;
}

describe("core/region font pre-warm (icon-font tofu fix)", () => {
  it("loads the declared font faces and awaits fonts.ready before rasterizing", async () => {
    const order: string[] = [];
    const face = { load: vi.fn(async () => void order.push("load")) };
    const fonts = {
      ready: (async () => void order.push("ready"))(),
      [Symbol.iterator]: () => [face][Symbol.iterator](),
    };
    html2canvas.mockImplementation(async () => {
      order.push("capture");
      return document.createElement("canvas");
    });
    const env = {
      doc: { body: document.createElement("section"), fonts } as unknown as Document,
      win: fakeWin(),
    };

    await rasterizeViewport(1, document.createElement("div"), env);

    expect(face.load).toHaveBeenCalledTimes(1);
    expect(html2canvas).toHaveBeenCalledTimes(1);
    // the font load + ready both happen before the capture
    expect(order.indexOf("load")).toBeLessThan(order.indexOf("capture"));
    expect(order.indexOf("ready")).toBeLessThan(order.indexOf("capture"));
  });

  it("proceeds when the document has no FontFaceSet (jsdom / older engines)", async () => {
    const env = {
      doc: { body: document.createElement("section") } as unknown as Document,
      win: fakeWin(),
    };
    await expect(rasterizeViewport(1, document.createElement("div"), env)).resolves.toBeTruthy();
    expect(html2canvas).toHaveBeenCalledTimes(1);
  });
});
