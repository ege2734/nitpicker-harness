// Cross-frame embed bridge — the full round trip over `postMessage`, host page ⇆ framed app, in one jsdom
// window. The host-side client (createHarnessEmbedClient) and the in-frame bridge (EmbedBridge) both listen
// on the shared window; direction is disambiguated by ORIGIN exactly as it would be across a real frame
// boundary. A tiny "poster" routes each side's outbound postMessage into a MessageEvent stamped with the
// SENDER's origin, so the receiver's origin gate does the real work.
//
// This is the task's required verification: a host `setMode('region')` reaches the in-frame layer; a
// simulated region mark (descriptor + screenshot blob) arrives at the host's `onMark`/`onMarkUpdated`; and a
// wrong-origin command/event is rejected. Runs under the default jsdom env.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbedBridge } from "../src/embed/bridge";
import { EmbedSink } from "../src/embed/sink";
import { createHarnessEmbedClient } from "../src/embed/client";
import type { QueueItem } from "../vendor/nitpicker/core/types";

const HOST = "https://loom.example"; // the outer host page (frames the embed page)
const HARNESS = "https://harness.example"; // where the embed page + app are served
const EVIL = "https://evil.example";

/** A postMessage target that dispatches onto the shared window, stamping the SENDER's origin. Source is left
 *  null (jsdom can't attach an arbitrary window); the client's source check degrades to the origin gate. */
function poster(senderOrigin: string): { postMessage: (data: unknown, targetOrigin: string) => void } & {
  targets: string[];
} {
  const targets: string[] = [];
  return {
    targets,
    postMessage(data: unknown, targetOrigin: string) {
      targets.push(targetOrigin);
      window.dispatchEvent(new MessageEvent("message", { data, origin: senderOrigin }));
    },
  };
}

/** Directly dispatch a message from an arbitrary origin (for the rejection cases). */
function dispatchFrom(origin: string, data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data, origin }));
}

function regionItem(id: string): QueueItem {
  return {
    id,
    kind: "region",
    text: "",
    pageUrl: `${HARNESS}/app`,
    route: "/app",
    viewport: { w: 800, h: 600, dpr: 1 },
    timestamp: "2026-07-07T00:00:00.000Z",
    image: { mime: "image/png", hasRedBox: true, selectionRect: { x: 1, y: 2, w: 30, h: 40 } },
  };
}

interface Rig {
  bridge: EmbedBridge;
  sink: EmbedSink;
  setMode: ReturnType<typeof vi.fn>;
  clearSelection: ReturnType<typeof vi.fn>;
  showSelection: ReturnType<typeof vi.fn>;
  bridgeParent: ReturnType<typeof poster>;
  iframeContent: ReturnType<typeof poster>;
  onMark: ReturnType<typeof vi.fn>;
  onMarkUpdated: ReturnType<typeof vi.fn>;
  onMarkRemoved: ReturnType<typeof vi.fn>;
  onStatus: ReturnType<typeof vi.fn>;
  onReady: ReturnType<typeof vi.fn>;
  client: ReturnType<typeof createHarnessEmbedClient>;
  destroy: () => void;
}

/** Stand up a bridge (trusts HOST) + a client (talks to HARNESS), cross-wired through the two posters. */
function rig(allowedOrigins: string[] = [HOST]): Rig {
  const setMode = vi.fn();
  const clearSelection = vi.fn();
  const showSelection = vi.fn();
  const bridgeParent = poster(HARNESS); // bridge → host: events carry origin HARNESS
  const iframeContent = poster(HOST); // client → frame: commands carry origin HOST

  const bridge = new EmbedBridge({
    allowedOrigins,
    onSetMode: setMode,
    onClearSelection: clearSelection,
    window,
    parent: bridgeParent as unknown as Window,
  });
  const sink = new EmbedSink(bridge);
  sink.layer = { showSelection };

  const onMark = vi.fn();
  const onMarkUpdated = vi.fn();
  const onMarkRemoved = vi.fn();
  const onStatus = vi.fn();
  const onReady = vi.fn();
  const listeners: Record<string, EventListener> = {};
  const iframe = {
    contentWindow: iframeContent as unknown as Window,
    addEventListener: (t: string, l: EventListener) => (listeners[t] = l),
    removeEventListener: () => {},
  } as unknown as HTMLIFrameElement;

  const client = createHarnessEmbedClient({
    iframe,
    origin: HARNESS,
    window,
    onMark,
    onMarkUpdated,
    onMarkRemoved,
    onStatus,
    onReady,
  });

  return {
    bridge,
    sink,
    setMode,
    clearSelection,
    showSelection,
    bridgeParent,
    iframeContent,
    onMark,
    onMarkUpdated,
    onMarkRemoved,
    onStatus,
    onReady,
    client,
    destroy: () => {
      client.destroy();
      bridge.destroy();
    },
  };
}

describe("embed bridge — host ⇆ frame round trip", () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  it("handshakes: the client's ready promise resolves and onReady fires", async () => {
    // The client sent `hello` on construction; the bridge replied `ready`.
    await expect(r.client.ready).resolves.toBeUndefined();
    expect(r.onReady).toHaveBeenCalled();
    r.destroy();
  });

  it("host setMode('region') drives the in-frame layer's mode", () => {
    r.client.setMode("region");
    expect(r.setMode).toHaveBeenCalledWith("region");
    r.client.clearSelection();
    expect(r.clearSelection).toHaveBeenCalled();
    r.destroy();
  });

  it("a simulated region mark arrives at the host with its descriptor, then its screenshot blob", () => {
    // Host arms region mode…
    r.client.setMode("region");
    expect(r.setMode).toHaveBeenCalledWith("region");
    // …the in-frame layer produces a region mark (html2canvas is stubbed by driving the sink directly).
    const item = regionItem("r1");
    r.sink.onMark(item, { left: 5, top: 5, width: 30, height: 40 });
    // The descriptor reached the host's onMark as a serialized WireItem (no client-only _fields).
    expect(r.onMark).toHaveBeenCalledTimes(1);
    const wire = r.onMark.mock.calls[0][0] as Record<string, unknown>;
    expect(wire.kind).toBe("region");
    expect((wire.image as { selectionRect: { w: number } }).selectionRect.w).toBe(30);
    expect(wire).not.toHaveProperty("_blob");
    // The persistent selection visual was shown over the framed app.
    expect(r.showSelection).toHaveBeenCalled();
    // Raster settles → the screenshot blob is relayed via mark-updated.
    const blob = new Blob([new Uint8Array([9, 9, 9])], { type: "image/png" });
    item._blob = blob;
    item._thumb = "data:image/png;base64,ZZZ";
    item._pending = undefined;
    r.sink.onCaptureSettled();
    expect(r.onMarkUpdated).toHaveBeenCalledTimes(1);
    const u = r.onMarkUpdated.mock.calls[0][0] as { id: string; image?: { blob?: Blob; thumb?: string } };
    expect(u.id).toBe("r1");
    expect(u.image?.blob).toBeInstanceOf(Blob);
    expect(u.image?.thumb).toBe("data:image/png;base64,ZZZ");
    r.destroy();
  });

  it("status + mark-removed lifecycle events reach the host", () => {
    r.sink.setStatus("Editing text — Enter to save.", "ok");
    expect(r.onStatus).toHaveBeenCalledWith({ message: "Editing text — Enter to save.", kind: "ok" });
    r.sink.removeMark("gone");
    expect(r.onMarkRemoved).toHaveBeenCalledWith("gone");
    r.destroy();
  });

  it("NEVER posts with a wildcard target origin (explicit origins only)", () => {
    r.client.setMode("element"); // host → frame
    r.sink.setStatus("hi"); // frame → host
    expect(r.iframeContent.targets.every((t) => t === HARNESS)).toBe(true);
    expect(r.bridgeParent.targets.every((t) => t === HOST)).toBe(true);
    expect([...r.iframeContent.targets, ...r.bridgeParent.targets]).not.toContain("*");
    r.destroy();
  });
});

describe("embed bridge — origin gate rejects untrusted traffic", () => {
  it("drops a setMode command from an untrusted origin", () => {
    const r = rig([HOST]);
    r.setMode.mockClear();
    dispatchFrom(EVIL, { source: "nitpicker-embed-host", v: 1, type: "setMode", mode: "region" });
    expect(r.setMode).not.toHaveBeenCalled();
    // …but the same command from the trusted host IS applied.
    dispatchFrom(HOST, { source: "nitpicker-embed-host", v: 1, type: "setMode", mode: "region" });
    expect(r.setMode).toHaveBeenCalledWith("region");
    r.destroy();
  });

  it("the host client ignores a frame event forged from an untrusted origin", () => {
    const r = rig([HOST]);
    r.onMark.mockClear();
    dispatchFrom(EVIL, { source: "nitpicker-embed", v: 1, type: "mark", item: { id: "x", kind: "element" } });
    expect(r.onMark).not.toHaveBeenCalled();
    // A genuine frame event (origin = the configured harness origin) is accepted.
    dispatchFrom(HARNESS, { source: "nitpicker-embed", v: 1, type: "mark", item: { id: "ok", kind: "element" } });
    expect(r.onMark).toHaveBeenCalledTimes(1);
    r.destroy();
  });
});
