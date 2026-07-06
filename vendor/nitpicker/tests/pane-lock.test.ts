// nitpicker — the docked pane must stay reflow-locked for the FULL dock-path raster, not just while the
// queue card is open. captureRegion's html2canvas reads the DOM ~1–2s AFTER the card closes, so a pane
// toggle or window resize in that window would change appWidth / <html> margin and desync the red box
// from what was selected. Invariants pinned here:
//   - While a dock raster is in flight (card already closed), the pane hide/show toggle is a no-op.
//   - A window resize in that window is suppressed (no reflow), then reconciled once the raster settles.
import { describe, it, expect, afterEach, vi } from "vitest";

// captureRegion returns a promise we resolve on demand (gate.release), so we can hold the raster "in
// flight" and assert the lock, then settle it and assert the reconcile.
const { rasterizeViewport, annotateRegion, captureRegion, gate } = vi.hoisted(() => {
  const gate: { release: (() => void) | null } = { release: null };
  return {
    rasterizeViewport: vi.fn(async () => ({ canvas: document.createElement("canvas"), warning: null })),
    annotateRegion: vi.fn(async () => ({
      blob: new Blob(["x"], { type: "image/png" }),
      thumb: "data:image/png;base64,AAAA",
    })),
    captureRegion: vi.fn(
      () =>
        new Promise((resolve) => {
          gate.release = () =>
            resolve({
              blob: new Blob(["x"], { type: "image/png" }),
              canvas: document.createElement("canvas"),
              thumb: "data:image/png;base64,AAAA",
              warning: null,
            });
        }),
    ),
    gate,
  };
});
vi.mock("../core/region", () => ({ rasterizeViewport, annotateRegion, captureRegion }));

import { Nitpicker } from "../core";
import type { NitpickerHandle } from "../core";

const PANE_W = 320; // keep in sync with overlay.ts PANE_W

const ORIGINAL_ENV = process.env.NODE_ENV;
const ORIGINAL_INNER_WIDTH = window.innerWidth;
let handle: NitpickerHandle | null = null;

afterEach(() => {
  handle?.unmount();
  handle = null;
  process.env.NODE_ENV = ORIGINAL_ENV;
  window.innerWidth = ORIGINAL_INNER_WIDTH;
  gate.release = null;
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
const reservedMargin = (): string => document.documentElement.style.marginRight;
const paneShown = (r: ShadowRoot): boolean =>
  r.querySelector(".np-panel")?.classList.contains("np-shown") ?? false;

/** Draw a region and commit it with Queue. The card closes synchronously; the raster is left in flight
 *  (captureRegion's promise is held open by the gate). */
function drawAndQueue(root: ShadowRoot): void {
  (root.querySelectorAll(".np-dock button")[1] as HTMLButtonElement).click(); // Region
  root.querySelector(".np-interaction")!.dispatchEvent(mouse("mousedown", 40, 60));
  window.dispatchEvent(mouse("mousemove", 300, 260));
  window.dispatchEvent(mouse("mouseup", 300, 260));
  const card = root.querySelector(".np-card")!;
  (card.querySelector("textarea") as HTMLTextAreaElement).value = "note";
  (
    Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Queue") as HTMLButtonElement
  ).click();
}

describe("pane stays reflow-locked for the full in-flight dock raster", () => {
  it("ignores the pane hide toggle while the raster is in flight, then honors it once settled", async () => {
    const root = mount();
    drawAndQueue(root);

    // card is closed but the raster is still pending — the pane must not reflow
    expect(root.querySelector(".np-card")).toBeNull();
    expect(captureRegion).toHaveBeenCalledTimes(1);
    expect(gate.release).not.toBeNull();

    // the pane must LOOK locked while the functional lock is active, or the toggle silently no-ops
    expect(root.querySelector(".np-panel")?.classList.contains("np-locked")).toBe(true);

    (root.querySelector(".np-pane-toggle") as HTMLButtonElement).click(); // try to hide
    expect(paneShown(root)).toBe(true); // no-op: still shown
    expect(reservedMargin()).toBe(`${PANE_W}px`); // gutter unchanged under the pending screenshot

    gate.release!();
    await vi.waitFor(() => expect(root.querySelector(".np-list .np-item img")).not.toBeNull());

    // lock released — the visual dimming is gone and the toggle works again
    expect(root.querySelector(".np-panel")?.classList.contains("np-locked")).toBe(false);
    (root.querySelector(".np-pane-toggle") as HTMLButtonElement).click();
    expect(paneShown(root)).toBe(false);
    expect(reservedMargin()).toBe("");
  });

  it("drops the region mark entirely when the Queue-time raster fails", async () => {
    captureRegion.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    const root = mount();
    drawAndQueue(root);

    // pushed optimistically: a single "capturing…" placeholder row
    expect(root.querySelectorAll(".np-list .np-item")).toHaveLength(1);

    // once the raster rejects the mark is removed, not left as a broken red-box-only region
    await vi.waitFor(() => expect(root.querySelectorAll(".np-list .np-item")).toHaveLength(0));
    expect(root.querySelector(".np-badge")?.textContent).toBe("0");
    // and the pane visual lock is released even on failure
    expect(root.querySelector(".np-panel")?.classList.contains("np-locked")).toBe(false);
  });

  it("suppresses a window resize during the raster, then reconciles the layout on settle", async () => {
    const root = mount();
    drawAndQueue(root);
    expect(reservedMargin()).toBe(`${PANE_W}px`);

    // shrink below the bottom-sheet breakpoint: reservedWidth() would drop to 0, but the reflow is locked
    window.innerWidth = 500;
    window.dispatchEvent(new Event("resize"));
    expect(reservedMargin()).toBe(`${PANE_W}px`); // stale on purpose — no reflow while pending

    gate.release!();
    // once the raster settles the deferred resize is reconciled: narrow viewport reserves no gutter
    await vi.waitFor(() => expect(reservedMargin()).toBe(""));
  });
});
