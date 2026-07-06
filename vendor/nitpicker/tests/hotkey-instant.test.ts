// nitpicker — the Region flow must feel INSTANT. Two invariants pinned here, both from live feedback:
//   1. The ⌘/Ctrl+Shift+X hotkey arms Region mode SYNCHRONOUSLY but must NOT rasterize the viewport on
//      the keypress itself — rasterizeViewport → html2canvas is a single multi-hundred-ms (heavy DOM:
//      ~1–2s) synchronous main-thread block, and running it inline stalls the mode-switch paint. It is
//      deferred past a paint (so the armed UI renders on the very next frame) and still fires a couple
//      frames later — before the cursor can travel to a drag — so hover-only UI is still captured.
//   2. A click (no meaningful drag) in Region mode is a cancel: it returns to Cursor, same as Esc.
import { describe, it, expect, afterEach, vi } from "vitest";

// Mock the region module so we can observe WHEN rasterizeViewport is invoked relative to the keypress.
const { rasterizeViewport, annotateRegion, captureRegion } = vi.hoisted(() => ({
  rasterizeViewport: vi.fn(async () => ({ canvas: document.createElement("canvas"), warning: null })),
  annotateRegion: vi.fn(async () => ({
    blob: new Blob(["x"], { type: "image/png" }),
    thumb: "data:image/png;base64,AAAA",
  })),
  captureRegion: vi.fn(async () => ({
    blob: new Blob(["x"], { type: "image/png" }),
    canvas: document.createElement("canvas"),
    thumb: "data:image/png;base64,AAAA",
    warning: null,
  })),
}));
vi.mock("../core/region", () => ({ rasterizeViewport, annotateRegion, captureRegion }));

import { Nitpicker } from "../core";
import type { NitpickerHandle } from "../core";

const ORIGINAL_ENV = process.env.NODE_ENV;
let handle: NitpickerHandle | null = null;

afterEach(() => {
  handle?.unmount();
  handle = null;
  process.env.NODE_ENV = ORIGINAL_ENV;
  document.querySelectorAll('[data-nitpicker="root"]').forEach((n) => n.remove());
  rasterizeViewport.mockClear();
  annotateRegion.mockClear();
  captureRegion.mockClear();
});

function mount(): ShadowRoot {
  process.env.NODE_ENV = "development";
  handle = Nitpicker.mount({ session: "t" });
  const host = document.querySelector('[data-nitpicker="root"]');
  if (!host?.shadowRoot) throw new Error("overlay host / shadowRoot missing");
  return host.shadowRoot;
}

const armed = (r: ShadowRoot): boolean =>
  r.querySelector(".np-interaction")!.classList.contains("np-armed");
const pressHotkey = (): void => {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "X",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
};
const mouse = (type: string, x: number, y: number): MouseEvent =>
  new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });

describe("region hotkey — instant mode switch, deferred raster", () => {
  it("arms Region synchronously on keypress but does NOT rasterize in the same tick", () => {
    const root = mount();
    pressHotkey();
    // mode flips immediately — the armed UI can paint on the very next frame…
    expect(armed(root)).toBe(true);
    // …while the (main-thread-blocking) raster has NOT been kicked yet; it is deferred past the paint.
    expect(rasterizeViewport).not.toHaveBeenCalled();
  });

  it("fires the deferred raster a short time after the keypress (hover-only UI still captured)", async () => {
    const root = mount();
    pressHotkey();
    expect(rasterizeViewport).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(rasterizeViewport).toHaveBeenCalledTimes(1));
    // and the frozen snapshot lands purely from the keypress (no drag needed)
    await vi.waitFor(() =>
      expect(root.querySelector(".np-snapshot")?.classList.contains("np-show")).toBe(true),
    );
  });

  it("shows the 'freezing viewport…' cue synchronously on keypress, then hides it once frozen", async () => {
    const root = mount();
    const cue = (): boolean =>
      root.querySelector(".np-freeze-cue")!.classList.contains("np-show");
    expect(cue()).toBe(false);
    pressHotkey();
    // cue is up immediately (paints before the raster's main-thread block) — the raster hasn't run yet
    expect(cue()).toBe(true);
    expect(rasterizeViewport).not.toHaveBeenCalled();
    // once the frozen snapshot lands, the cue goes away (user now draws over the frozen image)
    await vi.waitFor(() =>
      expect(root.querySelector(".np-snapshot")?.classList.contains("np-show")).toBe(true),
    );
    expect(cue()).toBe(false);
  });

  it("hides the cue if the user bails (Esc) before the snapshot lands", () => {
    const root = mount();
    pressHotkey();
    expect(root.querySelector(".np-freeze-cue")!.classList.contains("np-show")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector(".np-freeze-cue")!.classList.contains("np-show")).toBe(false);
  });

  it("cancels the deferred raster if the user bails (Esc) before it fires", async () => {
    mount();
    pressHotkey();
    expect(rasterizeViewport).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    // give the deferral frames a chance to fire — they must NOT, because Esc cancelled them
    await new Promise((r) => setTimeout(r, 60));
    expect(rasterizeViewport).not.toHaveBeenCalled();
  });
});

describe("region click-without-drag returns to Cursor", () => {
  it("a click (sub-threshold drag) in Region mode flips back to Cursor", () => {
    const root = mount();
    (root.querySelectorAll(".np-dock button")[1] as HTMLButtonElement).click(); // Region
    expect(armed(root)).toBe(true);
    // mousedown then mouseup ~in place: a 3×2px "drag" is below the 6px selection threshold → a click.
    root.querySelector(".np-interaction")!.dispatchEvent(mouse("mousedown", 200, 200));
    window.dispatchEvent(mouse("mouseup", 203, 202));
    // treated as a cancel: back to Cursor (interaction no longer armed), no capture card opened.
    expect(armed(root)).toBe(false);
    expect(root.querySelector(".np-card")).toBeNull();
    expect(captureRegion).not.toHaveBeenCalled();
  });
});
