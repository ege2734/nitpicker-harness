// nitpicker — Cmd/Ctrl+Shift+X region hotkey. The invariant that matters: the shortcut jumps straight
// into Region mode from ANY mode/focus AND freezes the viewport at key-press time, so hover-only UI (a
// chart hover-card, a tooltip that vanishes on mouse-move) is preserved before the cursor moves. The
// freeze is now a CHEAP DOM clone attached to the light DOM (region.ts buildFrozenClone), NOT an
// html2canvas raster — so it lands synchronously with zero main-thread block. The (~1–2s) html2canvas
// raster is deferred to Queue-commit; here we assert it does NOT run on the keypress. This test drives the
// REAL region code (only html2canvas is stubbed) so the clone actually attaches under jsdom.
import { describe, it, expect, afterEach, vi } from "vitest";

// Stub html2canvas (dev-only dynamic import in core/region.ts). Track calls so we can assert the raster is
// NOT triggered by the keypress. Honor width/height/scale so the capture-scale guard is satisfied.
const html2canvas = vi.fn(
  async (_el: Element, opts: { width?: number; height?: number; scale?: number }) => {
    const canvas = document.createElement("canvas");
    const scale = opts?.scale ?? 1;
    canvas.width = (opts?.width ?? window.innerWidth) * scale;
    canvas.height = (opts?.height ?? window.innerHeight) * scale;
    return canvas;
  },
);
vi.mock("html2canvas-pro", () => ({ default: html2canvas }));

import { Nitpicker } from "../core";
import type { NitpickerHandle } from "../core";

const ORIGINAL_ENV = process.env.NODE_ENV;
let handle: NitpickerHandle | null = null;

afterEach(() => {
  handle?.unmount();
  handle = null;
  process.env.NODE_ENV = ORIGINAL_ENV;
  document.querySelectorAll('[data-nitpicker="root"], [data-nitpicker="frozen"]').forEach((n) => n.remove());
  html2canvas.mockClear();
});

function shadow(): ShadowRoot {
  const host = document.querySelector('[data-nitpicker="root"]');
  if (!host?.shadowRoot) throw new Error("overlay host / shadowRoot missing");
  return host.shadowRoot;
}
const armed = (): boolean =>
  !!shadow().querySelector(".np-interaction")?.classList.contains("np-armed");
const frozenHolder = (): Element | null => document.querySelector('[data-nitpicker="frozen"]');

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

    expect(armed()).toBe(false); // starts passive

    const e = pressRegionHotkey();

    // Region mode is armed immediately (the interaction layer only carries np-armed in region mode)…
    expect(armed()).toBe(true);
    // …and we swallow the event so it can't collide with a browser/app binding.
    expect(e.defaultPrevented).toBe(true);
  });

  it("works with Ctrl (non-mac) too", () => {
    process.env.NODE_ENV = "development";
    handle = Nitpicker.mount({ session: "t" });

    pressRegionHotkey({ metaKey: false, ctrlKey: true });

    expect(armed()).toBe(true);
  });

  it("freezes the viewport as a cheap clone on activation — synchronously, with NO html2canvas raster", () => {
    process.env.NODE_ENV = "development";
    handle = Nitpicker.mount({ session: "t" });

    expect(frozenHolder()).toBeNull(); // no freeze before the hotkey

    pressRegionHotkey();

    // The freeze lands SYNCHRONOUSLY (no drag, no await): a light-DOM holder frozen from the keypress that
    // the user will box. Crucially the expensive raster is deferred — html2canvas must not run yet.
    expect(frozenHolder()).not.toBeNull();
    expect(html2canvas).not.toHaveBeenCalled();
  });

  it("Escape after a hotkey freeze returns to cursor and clears the frozen clone", () => {
    process.env.NODE_ENV = "development";
    handle = Nitpicker.mount({ session: "t" });

    pressRegionHotkey();
    expect(frozenHolder()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(armed()).toBe(false);
    expect(frozenHolder()).toBeNull();
    expect(html2canvas).not.toHaveBeenCalled();
  });
});
