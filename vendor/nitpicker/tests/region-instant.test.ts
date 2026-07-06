// nitpicker — the dock Region flow must be instant to DRAW and instant to CARD, with the screenshot
// rasterized only when the user commits with Queue (per-mark, async). Invariants pinned here:
//   - Dragging out the selection triggers NO rasterization (the box is a live overlay rect) — so there
//     is no freeze/stall while drawing.
//   - Releasing opens the queue card immediately, still with no raster.
//   - The raster fires only on Queue-click; a drag the user cancels captures nothing.
//   - The queued item shows a "capturing…" placeholder until the async blob/thumb land.
import { describe, it, expect, afterEach, vi } from "vitest";

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
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
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

const mouse = (type: string, x: number, y: number): MouseEvent =>
  new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
const clickDockBtn = (r: ShadowRoot, i: number): void =>
  (r.querySelectorAll(".np-dock button")[i] as HTMLButtonElement).click();

function drawRegion(root: ShadowRoot): void {
  clickDockBtn(root, 1); // Region
  root.querySelector(".np-interaction")!.dispatchEvent(mouse("mousedown", 40, 60));
  window.dispatchEvent(mouse("mousemove", 300, 260));
  window.dispatchEvent(mouse("mouseup", 300, 260));
}
function cardButton(root: ShadowRoot, label: string): HTMLButtonElement {
  const card = root.querySelector(".np-card")!;
  return Array.from(card.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;
}

describe("dock Region flow: instant draw, queue-time raster, optimistic card", () => {
  it("does NOT rasterize while drawing the selection (no freeze/stall)", () => {
    const root = mount();
    drawRegion(root);
    // the whole draw (mousedown → mousemove → mouseup) must not touch the rasterizer
    expect(rasterizeViewport).not.toHaveBeenCalled();
    expect(captureRegion).not.toHaveBeenCalled();
  });

  it("opens the queue card immediately on release, still with no raster", () => {
    const root = mount();
    drawRegion(root);
    // card is present synchronously right after mouse-up (nothing was awaited)
    expect(root.querySelector(".np-card")).not.toBeNull();
    expect(captureRegion).not.toHaveBeenCalled();
  });

  it("rasterizes only when the user commits with Queue (per mark)", async () => {
    const root = mount();
    drawRegion(root);
    (root.querySelector(".np-card textarea") as HTMLTextAreaElement).value = "note";
    cardButton(root, "Queue").click();

    expect(captureRegion).toHaveBeenCalledTimes(1);
    // the item is queued immediately with a "capturing…" placeholder…
    await vi.waitFor(() => expect(root.querySelectorAll(".np-list .np-item").length).toBe(1));
    // …which resolves to a real thumbnail once the async raster lands
    await vi.waitFor(() => expect(root.querySelector(".np-list .np-item img")).not.toBeNull());
  });

  it("captures nothing when the user cancels the card (discarded drag → no screenshot)", () => {
    const root = mount();
    drawRegion(root);
    cardButton(root, "Cancel").click();
    expect(captureRegion).not.toHaveBeenCalled();
    expect(root.querySelectorAll(".np-list .np-item").length).toBe(0);
  });
});
