// The builder pane's region-screenshot lightbox: full-screen the captured image, close on Esc / backdrop
// click, single-instance. Runs under the default jsdom env (URL.createObjectURL is unavailable there, so the
// _thumb data URL is exercised — the intended fallback).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openRegionLightbox, closeLightbox } from "../src/builder/lightbox";
import type { QueueItem } from "../vendor/nitpicker/core/types";

function region(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "r1",
    kind: "region",
    text: "",
    pageUrl: "http://x/",
    viewport: { w: 800, h: 600, dpr: 1 },
    timestamp: "2026-01-01T00:00:00Z",
    _thumb: "data:image/png;base64,AAA",
    ...over,
  } as QueueItem;
}

function box(): HTMLElement | null {
  return document.querySelector(".nh-lightbox");
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => closeLightbox());

describe("openRegionLightbox", () => {
  it("opens a full-screen backdrop with the screenshot", () => {
    openRegionLightbox(region());
    const el = box();
    expect(el).not.toBeNull();
    expect(el!.style.position).toBe("fixed");
    const img = el!.querySelector("img") as HTMLImageElement;
    expect(img.src).toContain("data:image/png");
  });

  it("no-ops when the mark has no image yet (still capturing)", () => {
    openRegionLightbox(region({ _thumb: undefined, _blob: undefined }));
    expect(box()).toBeNull();
  });

  it("closes on a backdrop click", () => {
    openRegionLightbox(region());
    const el = box()!;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(box()).toBeNull();
  });

  it("does NOT close when the image itself is clicked (only the backdrop)", () => {
    openRegionLightbox(region());
    const img = box()!.querySelector("img") as HTMLImageElement;
    img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(box()).not.toBeNull();
  });

  it("closes on Escape", () => {
    openRegionLightbox(region());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(box()).toBeNull();
  });

  it("is single-instance: opening a second closes the first", () => {
    openRegionLightbox(region());
    openRegionLightbox(region({ id: "r2" }));
    expect(document.querySelectorAll(".nh-lightbox").length).toBe(1);
  });
});
