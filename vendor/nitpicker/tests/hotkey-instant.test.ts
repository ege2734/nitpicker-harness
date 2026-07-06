// nitpicker — the Region hotkey flow must feel INSTANT. Invariants pinned here, all from live feedback:
//   1. ⌘/Ctrl+Shift+X arms Region mode AND freezes the viewport SYNCHRONOUSLY on the keypress — but the
//      freeze is now a CHEAP DOM clone (buildFrozenClone, ~one frame), NOT an html2canvas raster. The old
//      path ran html2canvas at key-press: a single ~1–2s SYNCHRONOUS main-thread block that stalled the
//      whole viewport. The expensive raster is DEFERRED to Queue-commit (rasterizeFrozen), reading the
//      clone — so hover-only UI is preserved without the block. No raster fires on the keypress.
//   2. The frozen clone lands purely from the keypress (a light-DOM holder), before any drag — so the
//      hover-only UI the user is about to box is already frozen.
//   3. A click (no meaningful drag) in Region mode is a cancel: it returns to Cursor, same as Esc.
import { describe, it, expect, afterEach, vi } from "vitest";

// Mock the region module so we can observe WHEN each stage runs relative to the keypress. buildFrozenClone
// attaches a real light-DOM holder (as the real one does) so teardown can be asserted; rasterizeFrozen is
// the deferred, off-key-press raster.
const { buildFrozenClone, rasterizeFrozen, annotateRegion, captureRegion } = vi.hoisted(() => ({
  buildFrozenClone: vi.fn(() => {
    const holder = document.createElement("div");
    holder.setAttribute("data-nitpicker", "frozen");
    document.body.appendChild(holder);
    return { holder, viewport: { w: window.innerWidth, h: window.innerHeight }, decode: Promise.resolve() };
  }),
  rasterizeFrozen: vi.fn(async () => ({ canvas: document.createElement("canvas"), warning: null })),
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
vi.mock("../core/region", () => ({ buildFrozenClone, rasterizeFrozen, annotateRegion, captureRegion }));

import { Nitpicker } from "../core";
import type { NitpickerHandle } from "../core";

const ORIGINAL_ENV = process.env.NODE_ENV;
let handle: NitpickerHandle | null = null;

afterEach(() => {
  handle?.unmount();
  handle = null;
  process.env.NODE_ENV = ORIGINAL_ENV;
  document.querySelectorAll('[data-nitpicker="root"], [data-nitpicker="frozen"]').forEach((n) => n.remove());
  buildFrozenClone.mockClear();
  rasterizeFrozen.mockClear();
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
const frozenHolder = (): Element | null => document.querySelector('[data-nitpicker="frozen"]');
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

function dragOnFrozen(root: ShadowRoot): void {
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

describe("region hotkey — instant freeze (cheap clone), deferred raster", () => {
  it("arms Region AND freezes (cheap clone) synchronously, but does NOT rasterize on the keypress", () => {
    const root = mount();
    pressHotkey();
    // mode + a frozen clone both land synchronously on the keypress…
    expect(armed(root)).toBe(true);
    expect(buildFrozenClone).toHaveBeenCalledTimes(1);
    expect(frozenHolder()).not.toBeNull();
    // …while the (main-thread-blocking) raster has NOT run — it is deferred to Queue-commit.
    expect(rasterizeFrozen).not.toHaveBeenCalled();
  });

  it("defers the raster to Queue-commit, reading the frozen clone (hover-only UI preserved)", async () => {
    const root = mount();
    pressHotkey();
    dragOnFrozen(root);
    // card opens on release with no raster yet…
    expect(root.querySelector(".np-card")).not.toBeNull();
    expect(rasterizeFrozen).not.toHaveBeenCalled();
    // …the raster of the FROZEN clone fires only on Queue…
    (root.querySelector(".np-card textarea") as HTMLTextAreaElement).value = "note";
    cardButton(root, "Queue").click();
    expect(rasterizeFrozen).toHaveBeenCalledTimes(1);
    // …the item queues immediately (placeholder) then resolves to a real thumbnail
    await vi.waitFor(() => expect(root.querySelectorAll(".np-list .np-item").length).toBe(1));
    await vi.waitFor(() => expect(root.querySelector(".np-list .np-item img")).not.toBeNull());
    // and the frozen holder is torn down once its raster settles
    await vi.waitFor(() => expect(frozenHolder()).toBeNull());
  });

  it("captures nothing and removes the frozen clone when the user cancels the card", () => {
    const root = mount();
    pressHotkey();
    dragOnFrozen(root);
    cardButton(root, "Cancel").click();
    expect(rasterizeFrozen).not.toHaveBeenCalled();
    expect(root.querySelectorAll(".np-list .np-item").length).toBe(0);
    expect(frozenHolder()).toBeNull();
  });

  it("Escape during the freeze (before any drag) returns to Cursor and clears the frozen clone", () => {
    const root = mount();
    pressHotkey();
    expect(frozenHolder()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(armed(root)).toBe(false);
    expect(frozenHolder()).toBeNull();
    expect(rasterizeFrozen).not.toHaveBeenCalled();
  });
});

describe("region click-without-drag returns to Cursor", () => {
  it("a click (sub-threshold drag) in Region mode flips back to Cursor and clears the freeze", () => {
    const root = mount();
    (root.querySelectorAll(".np-dock button")[1] as HTMLButtonElement).click(); // Region (no hotkey freeze)
    expect(armed(root)).toBe(true);
    // mousedown then mouseup ~in place: a 3×2px "drag" is below the 6px selection threshold → a click.
    root.querySelector(".np-interaction")!.dispatchEvent(mouse("mousedown", 200, 200));
    window.dispatchEvent(mouse("mouseup", 203, 202));
    // treated as a cancel: back to Cursor (interaction no longer armed), no capture card opened.
    expect(armed(root)).toBe(false);
    expect(root.querySelector(".np-card")).toBeNull();
    expect(captureRegion).not.toHaveBeenCalled();
    expect(rasterizeFrozen).not.toHaveBeenCalled();
  });
});
