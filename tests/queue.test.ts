// The builder pane's queued-mark UI, ported from the classic ShellChrome list + overlay item modal. Verifies
// the per-kind row, the expandable detail (region screenshot / element+edit descriptor), remove/toggle, and
// live note edit. Runs under the default jsdom env.
import { describe, it, expect, beforeEach } from "vitest";
import { buildQueueItem, kindLabel, descriptorLines, type QueueItemHandlers } from "../src/builder/queue";
import type { QueueItem } from "../vendor/nitpicker/core/types";

function baseItem(over: Partial<QueueItem>): QueueItem {
  return {
    id: "m1",
    kind: "region",
    text: "",
    pageUrl: "http://x/",
    route: "/dash",
    viewport: { w: 800, h: 600, dpr: 1 },
    timestamp: "2026-01-01T00:00:00Z",
    ...over,
  } as QueueItem;
}

const noopHandlers: QueueItemHandlers = { onRemove: () => {}, onToggle: () => {}, onNoteChange: () => {} };

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("kindLabel", () => {
  it("reflects region capture state", () => {
    expect(kindLabel(baseItem({ kind: "region" }))).toMatch(/capturing/i);
    expect(kindLabel(baseItem({ kind: "region", _thumb: "data:," }))).toBe("region ✓");
    expect(kindLabel(baseItem({ kind: "region", _error: "boom" }))).toBe("region ✕");
  });
  it("uses component then selector for elements", () => {
    expect(kindLabel(baseItem({ kind: "element", element: { component: "Card" } }))).toBe("⬡ Card");
    expect(kindLabel(baseItem({ kind: "element", element: { selector: ".btn" } }))).toBe(".btn");
  });
  it("labels text-edit and message", () => {
    expect(kindLabel(baseItem({ kind: "text-edit" }))).toBe("✎ edit");
    expect(kindLabel(baseItem({ kind: "message" }))).toBe("message");
  });
});

describe("descriptorLines", () => {
  it("emits only the present descriptor fields", () => {
    const lines = descriptorLines(
      baseItem({ kind: "element", element: { component: "Card", source: "a.tsx:3:1", selector: ".x" } }),
    );
    expect(lines).toEqual(["component: Card", "source: a.tsx:3:1", "selector: .x"]);
  });
});

describe("buildQueueItem (collapsed)", () => {
  it("renders the kind, note preview and a remove button; no detail", () => {
    const row = buildQueueItem(baseItem({ kind: "region", _thumb: "data:,", text: "fix this" }), noopHandlers, false);
    expect(row.querySelector(".nh-item-kind")!.textContent).toBe("region ✓");
    expect(row.querySelector(".nh-item-note")!.textContent).toBe("fix this");
    expect(row.querySelector(".nh-del")).not.toBeNull();
    expect(row.querySelector(".nh-item-detail")).toBeNull();
  });

  it("shows the source chip for element marks", () => {
    const row = buildQueueItem(
      baseItem({ kind: "element", element: { component: "Card", source: "a.tsx:3:1" } }),
      noopHandlers,
      false,
    );
    expect(row.querySelector(".nh-item-source")!.textContent).toBe("a.tsx:3:1");
  });

  it("remove button fires onRemove and does not toggle", () => {
    let removed: string | null = null;
    let toggled = false;
    const row = buildQueueItem(baseItem({}), {
      onRemove: (id) => (removed = id),
      onToggle: () => (toggled = true),
      onNoteChange: () => {},
    }, false);
    (row.querySelector(".nh-del") as HTMLButtonElement).click();
    expect(removed).toBe("m1");
    expect(toggled).toBe(false);
  });

  it("clicking the header toggles", () => {
    let toggled: string | null = null;
    const row = buildQueueItem(baseItem({}), { ...noopHandlers, onToggle: (id) => (toggled = id) }, false);
    (row.querySelector(".nh-item-head") as HTMLElement).click();
    expect(toggled).toBe("m1");
  });
});

describe("buildQueueItem (expanded)", () => {
  it("region: shows the red-boxed screenshot thumbnail", () => {
    const row = buildQueueItem(baseItem({ kind: "region", _thumb: "data:image/png;base64,AAA" }), noopHandlers, true);
    const img = row.querySelector("img.nh-item-img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toContain("data:image/png");
  });

  it("region: placeholder while capturing, failure note on error", () => {
    const capturing = buildQueueItem(baseItem({ kind: "region" }), noopHandlers, true);
    expect(capturing.querySelector(".nh-item-detail")!.textContent).toMatch(/capturing/i);
    const failed = buildQueueItem(baseItem({ kind: "region", _error: "x" }), noopHandlers, true);
    expect(failed.querySelector(".nh-item-detail")!.textContent).toMatch(/failed/i);
  });

  it("element: shows the descriptor lines", () => {
    const row = buildQueueItem(
      baseItem({ kind: "element", element: { component: "Card", source: "a.tsx:3:1", selector: ".x" } }),
      noopHandlers,
      true,
    );
    const desc = row.querySelector(".nh-item-desc")!.textContent!;
    expect(desc).toContain("component: Card");
    expect(desc).toContain("source: a.tsx:3:1");
  });

  it("text-edit: shows the old→new diff", () => {
    const row = buildQueueItem(
      baseItem({ kind: "text-edit", oldText: "Hi", newText: "Hello", element: { source: "a.tsx:1:1" } }),
      noopHandlers,
      true,
    );
    expect(row.querySelector(".nh-item-edit")!.textContent).toContain("Hi");
    expect(row.querySelector(".nh-item-edit")!.textContent).toContain("Hello");
  });

  it("route is shown; the note textarea pre-fills the current note", () => {
    const row = buildQueueItem(baseItem({ text: "orig" }), noopHandlers, true);
    expect(row.querySelector(".nh-item-route")!.textContent).toBe("/dash");
    expect((row.querySelector(".nh-item-noteedit") as HTMLTextAreaElement).value).toBe("orig");
  });

  it("Enter saves the edited note and collapses; Esc cancels without saving; Shift+Enter is a newline", () => {
    let saved: string | null = null;
    let toggled = 0;
    const handlers = { onRemove: () => {}, onToggle: () => toggled++, onNoteChange: (_id: string, n: string) => (saved = n) };

    // Enter → save + collapse
    let row = buildQueueItem(baseItem({ text: "orig" }), handlers, true);
    let ta = row.querySelector(".nh-item-noteedit") as HTMLTextAreaElement;
    ta.value = "edited";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(saved).toBe("edited");
    expect(toggled).toBe(1);

    // Esc → collapse, no save
    saved = null;
    row = buildQueueItem(baseItem({ text: "orig" }), handlers, true);
    ta = row.querySelector(".nh-item-noteedit") as HTMLTextAreaElement;
    ta.value = "discard me";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(saved).toBeNull();
    expect(toggled).toBe(2);

    // Shift+Enter → neither save nor collapse (newline)
    saved = null;
    row = buildQueueItem(baseItem({ text: "orig" }), handlers, true);
    ta = row.querySelector(".nh-item-noteedit") as HTMLTextAreaElement;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(saved).toBeNull();
    expect(toggled).toBe(2);
  });

  it("clicking the region screenshot opens a full-screen lightbox", () => {
    const row = buildQueueItem(baseItem({ kind: "region", _thumb: "data:image/png;base64,AAA" }), noopHandlers, true);
    document.body.appendChild(row);
    expect(document.querySelector(".nh-lightbox")).toBeNull();
    (row.querySelector("img.nh-item-img") as HTMLImageElement).click();
    const box = document.querySelector(".nh-lightbox");
    expect(box).not.toBeNull();
    expect((box!.querySelector("img") as HTMLImageElement).src).toContain("data:image/png");
    // cleanup
    box!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
});
