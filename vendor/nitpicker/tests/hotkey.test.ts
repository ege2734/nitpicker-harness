// nitpicker — Cmd/Ctrl+Shift+X region hotkey. The invariant that matters: the shortcut must jump
// straight into Region mode from ANY mode/focus AND freeze the viewport at key-press time, so hover-only
// UI (a chart hover-card, a tooltip that vanishes on mouse-move) is preserved in the snapshot the user
// then boxes. If the freeze slipped to drag-start/drag-end (as the dock path does) the hovered element
// would already be gone — so we assert both the mode flip and the eager freeze.
import { describe, it, expect, afterEach, vi } from "vitest";

// Stub html2canvas (dev-only dynamic import in core/region.ts) so freezeViewport() can rasterize under
// jsdom without the real DOM-painting dependency. Honor the requested width/height/scale (the app area
// is narrower than the viewport once the docked pane reserves its gutter) so the capture-scale guard is
// satisfied, same as the real html2canvas.
vi.mock("html2canvas", () => ({
  default: async (_el: Element, opts: { width?: number; height?: number; scale?: number }) => {
    const canvas = document.createElement("canvas");
    const scale = opts?.scale ?? 1;
    canvas.width = (opts?.width ?? window.innerWidth) * scale;
    canvas.height = (opts?.height ?? window.innerHeight) * scale;
    return canvas;
  },
}));

import { Nitpicker } from "../core";
import type { NitpickerHandle } from "../core";

const ORIGINAL_ENV = process.env.NODE_ENV;
let handle: NitpickerHandle | null = null;

afterEach(() => {
  handle?.unmount();
  handle = null;
  process.env.NODE_ENV = ORIGINAL_ENV;
  document.querySelectorAll('[data-nitpicker="root"]').forEach((n) => n.remove());
});

function shadow(): ShadowRoot {
  const host = document.querySelector('[data-nitpicker="root"]');
  if (!host?.shadowRoot) throw new Error("overlay host / shadowRoot missing");
  return host.shadowRoot;
}

function pressRegionHotkey(init: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  // Shift is held, so the browser reports the key as uppercase "X" — the handler lower-cases it.
  const e = new KeyboardEvent("keydown", {
    key: "X",
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.dispatchEvent(e);
  return e;
}

describe("region hotkey (⌘/Ctrl+Shift+X)", () => {
  it("activates Region mode synchronously and preventDefault()s the event", () => {
    process.env.NODE_ENV = "development";
    handle = Nitpicker.mount({ session: "t" });

    // starts passive
    expect(shadow().querySelector(".np-interaction")?.classList.contains("np-armed")).toBe(false);

    const e = pressRegionHotkey();

    // Region mode is armed immediately (the interaction layer only carries np-armed in region mode)…
    expect(shadow().querySelector(".np-interaction")?.classList.contains("np-armed")).toBe(true);
    // …and we swallow the event so it can't collide with a browser/app binding.
    expect(e.defaultPrevented).toBe(true);
  });

  it("works with Ctrl (non-mac) too", () => {
    process.env.NODE_ENV = "development";
    handle = Nitpicker.mount({ session: "t" });

    pressRegionHotkey({ metaKey: false, ctrlKey: true });

    expect(shadow().querySelector(".np-interaction")?.classList.contains("np-armed")).toBe(true);
  });

  it("freezes the viewport on activation — before any drag — so hover-only UI is captured", async () => {
    process.env.NODE_ENV = "development";
    handle = Nitpicker.mount({ session: "t" });

    // snapshot layer is empty/hidden before the hotkey
    expect(shadow().querySelector(".np-snapshot")?.classList.contains("np-show")).toBe(false);

    pressRegionHotkey();

    // The raster is async (html2canvas). No drag has happened — the freeze must land purely from the
    // keypress, painting a canvas into the snapshot backdrop that the user will later box.
    await vi.waitFor(() => {
      const snap = shadow().querySelector(".np-snapshot");
      expect(snap?.classList.contains("np-show")).toBe(true);
      expect(snap?.querySelector("canvas")).not.toBeNull();
    });
  });

  it("Escape after a hotkey freeze returns to cursor and clears the snapshot", async () => {
    process.env.NODE_ENV = "development";
    handle = Nitpicker.mount({ session: "t" });

    pressRegionHotkey();
    await vi.waitFor(() =>
      expect(shadow().querySelector(".np-snapshot")?.classList.contains("np-show")).toBe(true),
    );

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(shadow().querySelector(".np-interaction")?.classList.contains("np-armed")).toBe(false);
    expect(shadow().querySelector(".np-snapshot")?.classList.contains("np-show")).toBe(false);
    expect(shadow().querySelector(".np-snapshot")?.querySelector("canvas")).toBeNull();
  });
});
