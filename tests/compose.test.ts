// Builder composer semantics: Enter=queue, Cmd/Ctrl+Enter=flush, Shift+Enter=newline; and the flush
// grouping (queued messages → turn text, marks ride as context). Pure — no DOM. Default jsdom env.
import { describe, it, expect } from "vitest";
import { classifyComposerKey, partitionQueue } from "../src/builder/compose";
import type { QueueItem } from "../vendor/nitpicker/core/types";

function key(over: Partial<{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }>) {
  return { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, ...over };
}
function item(over: Partial<QueueItem>): QueueItem {
  return {
    id: Math.random().toString(36).slice(2),
    kind: "message",
    text: "",
    pageUrl: "http://x/",
    viewport: { w: 1, h: 1, dpr: 1 },
    timestamp: "2026-01-01T00:00:00Z",
    ...over,
  } as QueueItem;
}

describe("classifyComposerKey", () => {
  it("Enter → queue", () => {
    expect(classifyComposerKey(key({}))).toBe("queue");
  });
  it("Cmd+Enter (mac) and Ctrl+Enter (other) → flush", () => {
    expect(classifyComposerKey(key({ metaKey: true }))).toBe("flush");
    expect(classifyComposerKey(key({ ctrlKey: true }))).toBe("flush");
  });
  it("Shift+Enter → newline", () => {
    expect(classifyComposerKey(key({ shiftKey: true }))).toBe("newline");
  });
  it("non-Enter → null (default handling)", () => {
    expect(classifyComposerKey(key({ key: "a" }))).toBeNull();
  });
});

describe("partitionQueue", () => {
  it("joins queued messages in order into the turn text; marks ride separately", () => {
    const q = [
      item({ kind: "message", text: "first" }),
      item({ kind: "region", text: "look here" }),
      item({ kind: "message", text: "second" }),
      item({ kind: "element", text: "" }),
    ];
    const { text, marks } = partitionQueue(q);
    expect(text).toBe("first\n\nsecond");
    expect(marks.map((m) => m.kind)).toEqual(["region", "element"]);
  });

  it("empty text when there are no message items; marks still returned", () => {
    const { text, marks } = partitionQueue([item({ kind: "region", text: "x" })]);
    expect(text).toBe("");
    expect(marks).toHaveLength(1);
  });

  it("a single typed message becomes the whole turn text with no marks", () => {
    const { text, marks } = partitionQueue([item({ kind: "message", text: "just this" })]);
    expect(text).toBe("just this");
    expect(marks).toHaveLength(0);
  });
});
