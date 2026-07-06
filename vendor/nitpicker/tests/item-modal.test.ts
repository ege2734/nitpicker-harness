// nitpicker — clicking a queued item opens a view/edit modal: the screenshot (region) or descriptor
// (element), the message in an editable field that saves back in place, plus Remove and close (Esc/✕).
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
  document.querySelectorAll("[data-probe]").forEach((n) => n.remove());
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

const mouse = (type: string, x: number, y: number): MouseEvent =>
  new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });

/** Queue one element mark (no canvas/object-URL needed) and return its row. */
function queueElementMark(root: ShadowRoot, note: string): void {
  const probe = document.createElement("button");
  probe.setAttribute("data-probe", "");
  probe.setAttribute("data-testid", "kpi-total");
  document.body.appendChild(probe);
  (root.querySelectorAll(".np-dock button")[2] as HTMLButtonElement).click(); // Element
  probe.dispatchEvent(mouse("click", 20, 20));
  const card = root.querySelector(".np-card")!;
  (card.querySelector("textarea") as HTMLTextAreaElement).value = note;
  (
    Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Queue") as HTMLButtonElement
  ).click();
}

describe("queued item view/edit modal", () => {
  it("opens a modal when a queued item row is clicked", () => {
    const root = mount();
    queueElementMark(root, "original note");

    expect(root.querySelector(".np-modal")).toBeNull();
    (root.querySelector(".np-list .np-item") as HTMLElement).click();

    const modal = root.querySelector(".np-modal");
    expect(modal).not.toBeNull();
    // element mark shows its descriptor + the message prefilled for editing
    expect(modal!.querySelector(".np-modal-desc")?.textContent).toContain("kpi-total");
    expect((modal!.querySelector("textarea") as HTMLTextAreaElement).value).toBe("original note");
  });

  it("saves an edited message back to the queued item in place", () => {
    const root = mount();
    queueElementMark(root, "before");
    (root.querySelector(".np-list .np-item") as HTMLElement).click();

    const ta = root.querySelector(".np-modal textarea") as HTMLTextAreaElement;
    ta.value = "after edit";
    (
      Array.from(root.querySelectorAll(".np-modal button")).find(
        (b) => b.textContent === "Save",
      ) as HTMLButtonElement
    ).click();

    expect(root.querySelector(".np-modal")).toBeNull(); // closed
    expect(root.querySelector(".np-list .np-item-text")?.textContent).toBe("after edit");
  });

  it("removes the item from the modal", () => {
    const root = mount();
    queueElementMark(root, "to remove");
    (root.querySelector(".np-list .np-item") as HTMLElement).click();

    (
      Array.from(root.querySelectorAll(".np-modal button")).find(
        (b) => b.textContent === "Remove",
      ) as HTMLButtonElement
    ).click();

    expect(root.querySelector(".np-modal")).toBeNull();
    expect(root.querySelectorAll(".np-list .np-item").length).toBe(0);
    expect(root.querySelector(".np-badge")?.textContent).toBe("0");
  });

  it("closes on Escape", () => {
    const root = mount();
    queueElementMark(root, "note");
    (root.querySelector(".np-list .np-item") as HTMLElement).click();
    expect(root.querySelector(".np-modal")).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector(".np-modal")).toBeNull();
  });

  it("raises the freeze layer above the docked pane while the modal is open, releasing on close", () => {
    const root = mount();
    queueElementMark(root, "note");
    const freeze = root.querySelector(".np-freeze")!;
    expect(freeze.classList.contains("np-over-pane")).toBe(false);

    (root.querySelector(".np-list .np-item") as HTMLElement).click();
    // the modal must stack over the pane (which paints later in DOM order) so Save/Remove stay clickable
    expect(freeze.classList.contains("np-over-pane")).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(freeze.classList.contains("np-over-pane")).toBe(false);
  });
});
