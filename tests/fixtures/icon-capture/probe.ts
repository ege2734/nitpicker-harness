// Capture probe for the icon-font verification loop. Exposes the REAL region.ts capture on `window` so a
// Playwright driver can rasterize this page and inspect the PNG for tofu vs real glyphs. NOT shipped.
import { rasterizeViewport } from "../../../vendor/nitpicker/core/region";

declare global {
  interface Window {
    __nhRaster: (scale?: number) => Promise<string>;
    __nhReady: boolean;
  }
}

window.__nhRaster = async (scale = 2): Promise<string> => {
  const host = document.createElement("div"); // detached dummy host (not in DOM) → ignoreElements no-op
  const { canvas } = await rasterizeViewport(scale, host);
  return canvas.toDataURL("image/png");
};

// Cross-document capture — exactly like the harness builder/shell: run in the PARENT window but rasterize the
// same-origin IFRAME's document via the Env seam. This is where html2canvas's font embedding reads the WRONG
// document's stylesheets (the parent's), losing the iframe's @font-face.
window.__nhRasterIframe = async (scale = 2): Promise<string> => {
  const frame = document.getElementById("frame") as HTMLIFrameElement;
  const env = { doc: frame.contentDocument as Document, win: frame.contentWindow as Window };
  await (env.doc as Document).fonts?.ready;
  const host = document.createElement("div");
  const { canvas } = await rasterizeViewport(scale, host, env);
  return canvas.toDataURL("image/png");
};
window.__nhReady = true;
