// nitpicker — two region-mode overlay UX fixes (harness-local, driven from a live session):
//   Issue 2 — the selection VISUAL (red outline + dim bands) must PERSIST after mouse-up, so the user can
//     see what they framed while composing the message. It is torn down only when the card is committed
//     (Queue) or dismissed (Cancel/Esc/backdrop). Previously onDragEnd/captureFrozen hid it immediately.
//   Issue 1 — entering region-freeze must not shift the underlying content. The frozen clone (and the whole
//     region coordinate space) is laid out at the app's CONTENT width — documentElement.clientWidth minus
//     the pane gutter — which EXCLUDES a classic scrollbar. Using innerWidth made the clone scrollbarWidth
//     px too wide, so the opaque frozen snapshot appeared shifted vs the live page it replaced.
import { describe, it, expect, afterEach, vi } from "vitest";

// Mock the raster/freeze module so no html2canvas runs. buildFrozenClone attaches a real light-DOM holder
// (as the real one does) and we capture the `appWidthCss` it is handed to assert the coordinate space.
const { buildFrozenClone, rasterizeFrozen, annotateRegion, captureRegion } = vi.hoisted(() => ({
  buildFrozenClone: vi.fn((_host: unknown, appWidthCss: number) => {
    const holder = document.createElement("div");
    holder.setAttribute("data-nitpicker", "frozen");
    document.body.appendChild(holder);
    return { holder, viewport: { w: appWidthCss, h: window.innerHeight }, decode: Promise.resolve() };
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
  document
    .querySelectorAll('[data-nitpicker="root"], [data-nitpicker="frozen"]')
    .forEach((n) => n.remove());
  // drop any stubbed clientWidth (own prop) so the prototype getter is restored
  delete (document.documentElement as unknown as { clientWidth?: number }).clientWidth;
  buildFrozenClone.mockClear();
  rasterizeFrozen.mockClear();
  annotateRegion.mockClear();
  captureRegion.mockClear();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

function mount(): ShadowRoot {
  process.env.NODE_ENV = "development";
  handle = Nitpicker.mount({ session: "t" });
  const host = document.querySelector('[data-nitpicker="root"]');
  if (!host?.shadowRoot) throw new Error("overlay host / shadowRoot missing");
  return host.shadowRoot;
}

/** Force documentElement.clientWidth (simulating a classic scrollbar gutter of innerWidth − value). */
function stubClientWidth(px: number): void {
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    get: () => px,
  });
}

const mouse = (type: string, x: number, y: number): MouseEvent =>
  new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
const clickDockBtn = (r: ShadowRoot, i: number): void =>
  (r.querySelectorAll(".np-dock button")[i] as HTMLButtonElement).click();
const pressHotkey = (): void => {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "X", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }),
  );
};

function drawRegionDock(root: ShadowRoot): void {
  clickDockBtn(root, 1); // Region
  root.querySelector(".np-interaction")!.dispatchEvent(mouse("mousedown", 40, 60));
  window.dispatchEvent(mouse("mousemove", 300, 260));
  window.dispatchEvent(mouse("mouseup", 300, 260));
}
function drawRegionHotkey(root: ShadowRoot): void {
  pressHotkey();
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
const outline = (r: ShadowRoot): HTMLElement => r.querySelector(".np-outline") as HTMLElement;
const bands = (r: ShadowRoot): HTMLElement[] =>
  Array.from(r.querySelectorAll(".np-band")) as HTMLElement[];
const selectionShown = (r: ShadowRoot): boolean =>
  outline(r).style.display === "block" && bands(r).every((b) => b.style.display === "block");
const selectionHidden = (r: ShadowRoot): boolean =>
  outline(r).style.display === "none" && bands(r).every((b) => b.style.display === "none");

describe("Issue 2 — region selection visual persists until commit/dismiss (dock path)", () => {
  it("keeps the red outline + dim bands ON SCREEN after mouse-up, with the card open", () => {
    const root = mount();
    drawRegionDock(root);
    expect(root.querySelector(".np-card")).not.toBeNull();
    expect(selectionShown(root)).toBe(true); // the framed region stays visible while composing
  });

  it("tears the selection down when the card is CANCELLED", () => {
    const root = mount();
    drawRegionDock(root);
    cardButton(root, "Cancel").click();
    expect(selectionHidden(root)).toBe(true);
  });

  it("tears the selection down when the card is QUEUED", () => {
    const root = mount();
    drawRegionDock(root);
    (root.querySelector(".np-card textarea") as HTMLTextAreaElement).value = "note";
    cardButton(root, "Queue").click();
    expect(selectionHidden(root)).toBe(true);
  });

  it("tears the selection down on Escape", () => {
    const root = mount();
    drawRegionDock(root);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(selectionHidden(root)).toBe(true);
  });
});

describe("Issue 2 — region selection visual persists until commit/dismiss (hotkey path)", () => {
  it("keeps the red outline + dim bands ON TOP of the frozen clone after mouse-up", () => {
    const root = mount();
    drawRegionHotkey(root);
    expect(root.querySelector(".np-card")).not.toBeNull();
    expect(document.querySelector('[data-nitpicker="frozen"]')).not.toBeNull();
    expect(selectionShown(root)).toBe(true);
  });

  it("tears the selection down when the card is cancelled", () => {
    const root = mount();
    drawRegionHotkey(root);
    cardButton(root, "Cancel").click();
    expect(selectionHidden(root)).toBe(true);
  });
});

describe("Issue 1 — freeze/region geometry excludes a classic scrollbar gutter (no shift)", () => {
  it("lays the drag coordinate space out at clientWidth − pane, NOT innerWidth − pane", () => {
    stubClientWidth(window.innerWidth - 15); // 15px classic scrollbar
    const root = mount();
    drawRegionDock(root);
    // The top dim band spans the full app content width (updateDrag sets it to appWidth). With a 15px
    // scrollbar the app content width is (innerWidth − 15) − 320, not innerWidth − 320.
    const appWidth = window.innerWidth - 15 - 320;
    expect(bands(root)[0].style.width).toBe(`${appWidth}px`);
  });

  it("hands the frozen clone the scrollbar-corrected width so it aligns with the live app", () => {
    stubClientWidth(window.innerWidth - 15);
    const root = mount();
    pressHotkey();
    const appWidth = window.innerWidth - 15 - 320;
    expect(buildFrozenClone).toHaveBeenCalledTimes(1);
    // buildFrozenClone(host, appWidthCss, env) — the 2nd arg is the layout width for the clone.
    expect(buildFrozenClone.mock.calls[0][1]).toBe(appWidth);
  });

  it("falls back to innerWidth when clientWidth is 0 (jsdom / pre-layout) — behavior unchanged", () => {
    // no stub → jsdom clientWidth is 0
    const root = mount();
    drawRegionDock(root);
    expect(bands(root)[0].style.width).toBe(`${window.innerWidth - 320}px`);
  });
});
