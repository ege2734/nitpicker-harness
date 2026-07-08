// Cross-frame embed bridge — the PURE wire-protocol helpers (src/embed/protocol.ts) + the mark-relay logic
// of the EmbedSink (src/embed/sink.ts). No DOM/postMessage here — the full round trip is in
// tests/embed-bridge.test.ts. Runs under the default jsdom env (jsdom only for the Blob constructor).
import { describe, it, expect, vi } from "vitest";
import {
  originAllowed,
  parseOrigins,
  isHostCommand,
  isFrameEvent,
  isEmbedMode,
  HOST_SOURCE,
  FRAME_SOURCE,
} from "../src/embed/protocol";
import { EmbedSink, type EmbedSinkBridge } from "../src/embed/sink";
import type { QueueItem } from "../vendor/nitpicker/core/types";

describe("embed protocol — origin allow-list (the security gate)", () => {
  const allow = ["https://loom.example", "https://app.loom.example"];
  it("accepts an exact configured origin", () => {
    expect(originAllowed("https://loom.example", allow)).toBe(true);
    expect(originAllowed("https://app.loom.example", allow)).toBe(true);
  });
  it("rejects an origin not on the list", () => {
    expect(originAllowed("https://evil.example", allow)).toBe(false);
    expect(originAllowed("https://loom.example.evil.com", allow)).toBe(false);
  });
  it("never trusts an empty origin, a wildcard, or a wildcard-configured list", () => {
    expect(originAllowed("", allow)).toBe(false);
    expect(originAllowed("null", allow)).toBe(false); // sandboxed/file frames report "null"
    expect(originAllowed("*", allow)).toBe(false);
    expect(originAllowed("https://anything.example", ["*"])).toBe(false);
    expect(originAllowed("https://anything.example", [""])).toBe(false);
  });
});

describe("embed protocol — parseOrigins", () => {
  it("splits, trims, dedupes, and drops empties + the unsafe wildcard", () => {
    expect(parseOrigins("https://a.example, https://b.example ,https://a.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(parseOrigins("https://a.example, *, ")).toEqual(["https://a.example"]);
    expect(parseOrigins("")).toEqual([]);
    expect(parseOrigins(null)).toEqual([]);
    expect(parseOrigins(undefined)).toEqual([]);
  });
});

describe("embed protocol — message narrowing", () => {
  it("isHostCommand / isFrameEvent gate on the source tag + a type", () => {
    expect(isHostCommand({ source: HOST_SOURCE, v: 1, type: "setMode", mode: "region" })).toBe(true);
    expect(isHostCommand({ source: FRAME_SOURCE, v: 1, type: "mark" })).toBe(false);
    expect(isHostCommand(null)).toBe(false);
    expect(isHostCommand("nope")).toBe(false);
    expect(isHostCommand({ source: HOST_SOURCE })).toBe(false); // no type

    expect(isFrameEvent({ source: FRAME_SOURCE, v: 1, type: "ready", modes: [] })).toBe(true);
    expect(isFrameEvent({ source: FRAME_SOURCE, v: 1, type: "mode", mode: "region" })).toBe(true);
    expect(isFrameEvent({ source: HOST_SOURCE, v: 1, type: "hello" })).toBe(false);
  });
  it("isEmbedMode only accepts the four known modes", () => {
    for (const m of ["cursor", "region", "element", "edit"]) expect(isEmbedMode(m)).toBe(true);
    expect(isEmbedMode("delete")).toBe(false);
    expect(isEmbedMode(3)).toBe(false);
    expect(isEmbedMode(undefined)).toBe(false);
  });
});

function fakeBridge(): EmbedSinkBridge & {
  marks: unknown[];
  updated: unknown[];
  removed: string[];
  statuses: unknown[];
} {
  const marks: unknown[] = [];
  const updated: unknown[] = [];
  const removed: string[] = [];
  const statuses: unknown[] = [];
  return {
    marks,
    updated,
    removed,
    statuses,
    emitMark: (item) => marks.push(item),
    emitMarkUpdated: (id, image, error) => updated.push({ id, image, error }),
    emitMarkRemoved: (id) => removed.push(id),
    emitStatus: (message, kind) => statuses.push({ message, kind }),
  };
}

function elementItem(id: string): QueueItem {
  return {
    id,
    kind: "element",
    text: "",
    pageUrl: "https://harness/app",
    route: "/app",
    viewport: { w: 800, h: 600, dpr: 1 },
    timestamp: "2026-07-07T00:00:00.000Z",
    element: { component: "PricingCard", source: "src/Pricing.tsx:12:4", selector: "[data-testid=pro]" },
  };
}

function regionItem(id: string): QueueItem {
  return {
    id,
    kind: "region",
    text: "",
    pageUrl: "https://harness/app",
    route: "/app",
    viewport: { w: 800, h: 600, dpr: 1 },
    timestamp: "2026-07-07T00:00:00.000Z",
    image: { mime: "image/png", hasRedBox: true, selectionRect: { x: 1, y: 2, w: 3, h: 4 } },
  };
}

describe("EmbedSink — relays marks to the bridge (no local queue)", () => {
  it("emits an element mark as a serialized WireItem (client-only _fields stripped) + drives the selection", () => {
    const bridge = fakeBridge();
    const sink = new EmbedSink(bridge);
    const showSelection = vi.fn();
    sink.layer = { showSelection };
    const anchor = { left: 10, top: 20, width: 100, height: 40 };
    sink.onMark(elementItem("e1"), anchor);
    expect(bridge.marks).toHaveLength(1);
    const wire = bridge.marks[0] as Record<string, unknown>;
    expect(wire.kind).toBe("element");
    expect((wire.element as { component?: string }).component).toBe("PricingCard");
    expect(wire).not.toHaveProperty("_blob");
    expect(wire).not.toHaveProperty("_pending");
    expect(showSelection).toHaveBeenCalledWith(anchor);
  });

  it("region: onMark emits the descriptor first, then the screenshot blob once the raster settles", () => {
    const bridge = fakeBridge();
    const sink = new EmbedSink(bridge);
    sink.layer = { showSelection: vi.fn() };
    const item = regionItem("r1");
    sink.onMark(item, { left: 0, top: 0, width: 5, height: 5 });
    // The mark rode immediately with no pixels; the update has not fired yet.
    expect(bridge.marks).toHaveLength(1);
    expect(bridge.updated).toHaveLength(0);
    // Raster resolves: the layer attaches the blob/thumb and calls onCaptureSettled.
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    item._blob = blob;
    item._thumb = "data:image/png;base64,AAAA";
    item._pending = undefined;
    sink.onCaptureSettled();
    expect(bridge.updated).toHaveLength(1);
    const u = bridge.updated[0] as { id: string; image?: { blob?: Blob; thumb?: string; mime: string } };
    expect(u.id).toBe("r1");
    expect(u.image?.blob).toBe(blob);
    expect(u.image?.thumb).toBe("data:image/png;base64,AAAA");
    expect(u.image?.mime).toBe("image/png");
    // A second settled callback does not re-emit (the item is no longer tracked).
    sink.onCaptureSettled();
    expect(bridge.updated).toHaveLength(1);
  });

  it("region capture failure: removeMark withdraws it (host learns via mark-removed) and settle is a no-op", () => {
    const bridge = fakeBridge();
    const sink = new EmbedSink(bridge);
    sink.layer = { showSelection: vi.fn() };
    const item = regionItem("r2");
    sink.onMark(item, undefined);
    // The interaction layer marks the item failed, calls removeMark (→ mark-removed), THEN onCaptureSettled
    // — matching src/shell/interaction.ts's catch-before-finally ordering. removeMark stops tracking, so the
    // settle finds nothing to relay.
    item._error = "capture failed";
    item._pending = undefined;
    sink.removeMark("r2");
    sink.onCaptureSettled();
    expect(bridge.removed).toEqual(["r2"]);
    expect(bridge.updated).toHaveLength(0);
  });

  it("a still-pending region does not emit an update", () => {
    const bridge = fakeBridge();
    const sink = new EmbedSink(bridge);
    sink.layer = { showSelection: vi.fn() };
    const item = regionItem("r3");
    sink.onMark(item, undefined);
    item._pending = Promise.resolve();
    sink.onCaptureSettled();
    expect(bridge.updated).toHaveLength(0);
  });

  it("takeNote is empty (host owns annotation) and setStatus relays through the bridge", () => {
    const bridge = fakeBridge();
    const sink = new EmbedSink(bridge);
    expect(sink.takeNote()).toBe("");
    sink.setStatus("hi", "ok");
    expect(bridge.statuses).toEqual([{ message: "hi", kind: "ok" }]);
  });
});
