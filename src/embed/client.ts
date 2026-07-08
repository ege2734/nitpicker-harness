// nitpicker-harness — the HOST-SIDE half of the cross-frame embed bridge. This is the ONE clean API a host
// (Loom's DS builder chrome) imports instead of hand-writing postMessage plumbing:
//
//   import { createHarnessEmbedClient } from "nitpicker-harness";
//   const client = createHarnessEmbedClient({
//     iframe,                         // the <iframe src="…/__nitpicker-harness/embed"> element
//     origin: "https://harness.host", // the harness ORIGIN (where the embed page is served)
//     onMark: (mark) => store.add(mark),           // a WireItem (element/region/text-edit)
//     onMarkUpdated: (u) => store.attachShot(u.id, u.image?.blob),  // region screenshot arrived
//   });
//   client.setMode("region");         // drive the in-frame InteractionLayer
//   client.clearSelection();          // after the host queues/discards the mark
//   client.destroy();                 // detach the listener
//
// It is environment-agnostic (pure DOM: `window`/`postMessage`), so a browser bundler that consumes this
// package can tree-shake it in even though the package's main entry is node-targeted. `window` is injectable
// for tests. Security is symmetric with the frame side: inbound events are accepted ONLY from `opts.origin`
// (and, when resolvable, only from the framed window), and commands go out with an explicit target origin.
import {
  EMBED_PROTOCOL_VERSION,
  HOST_SOURCE,
  isFrameEvent,
  type EmbedMode,
  type HostCommand,
  type HostCommandBody,
  type MarkEvent,
  type MarkRemovedEvent,
  type MarkUpdatedEvent,
  type StatusEvent,
} from "./protocol";
import type { WireItem } from "../agent/backend";

export interface HarnessEmbedClientOptions {
  /** The `<iframe>` element hosting the harness embed page (`…/__nitpicker-harness/embed`). */
  iframe: HTMLIFrameElement;
  /** The harness ORIGIN the embed page is served from — the target origin for commands AND the only origin
   *  inbound events are accepted from. */
  origin: string;
  /** A mark was produced (element/region/text-edit). For a region the screenshot arrives later via
   *  `onMarkUpdated`. */
  onMark?: (mark: WireItem) => void;
  /** A region mark's screenshot finished (or failed). `image.blob` is the full-res PNG. */
  onMarkUpdated?: (update: { id: string; image?: { mime: string; blob?: Blob; thumb?: string }; error?: string }) => void;
  /** A previously-emitted mark was withdrawn (e.g. a region whose capture failed). */
  onMarkRemoved?: (id: string) => void;
  /** Best-effort status line from the in-frame layer. */
  onStatus?: (status: { message: string; kind?: "ok" | "err" }) => void;
  /** The bridge handshake completed (also resolves the `ready` promise). May fire more than once. */
  onReady?: () => void;
  /** Window to listen on / drive from. Default: the ambient `window`. Injectable for tests. */
  window?: Window;
}

export interface HarnessEmbedClient {
  /** Drive the in-frame InteractionLayer's mode (cursor = passive). */
  setMode(mode: EmbedMode): void;
  /** Clear the persistent selection visual over the framed app (call after queueing/discarding a mark). */
  clearSelection(): void;
  /** Resolves once the bridge has handshaked at least once. */
  readonly ready: Promise<void>;
  /** Detach the message listener. */
  destroy(): void;
}

/** Wire a host page to the harness embed bridge inside `iframe`. Returns the command surface + a `ready`
 *  promise. Safe to call before the iframe has loaded — it (re)sends the `hello` handshake on `load`. */
export function createHarnessEmbedClient(opts: HarnessEmbedClientOptions): HarnessEmbedClient {
  const win = opts.window ?? window;
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));
  let readied = false;

  const post = (cmd: HostCommandBody): void => {
    const target = opts.iframe.contentWindow;
    if (!target) return;
    target.postMessage({ source: HOST_SOURCE, v: EMBED_PROTOCOL_VERSION, ...cmd } as HostCommand, opts.origin);
  };

  const onMessage = (ev: MessageEvent): void => {
    // Primary gate: accept ONLY from the configured harness origin.
    if (ev.origin !== opts.origin) return;
    // Defense-in-depth: when the source window is resolvable, require it to be our iframe's window. (Some
    // environments — and jsdom — leave `source` null; the origin gate above still holds in that case.)
    if (ev.source && opts.iframe.contentWindow && ev.source !== opts.iframe.contentWindow) return;
    if (!isFrameEvent(ev.data)) return;
    switch (ev.data.type) {
      case "ready":
        if (!readied) {
          readied = true;
          resolveReady();
        }
        opts.onReady?.();
        break;
      case "mark":
        opts.onMark?.((ev.data as MarkEvent).item);
        break;
      case "mark-updated": {
        const d = ev.data as MarkUpdatedEvent;
        opts.onMarkUpdated?.({ id: d.id, image: d.image, error: d.error });
        break;
      }
      case "mark-removed":
        opts.onMarkRemoved?.((ev.data as MarkRemovedEvent).id);
        break;
      case "status": {
        const d = ev.data as StatusEvent;
        opts.onStatus?.({ message: d.message, kind: d.kind });
        break;
      }
    }
  };

  win.addEventListener("message", onMessage);
  // Kick the handshake now (in case the bridge is already live) and again whenever the iframe (re)loads.
  const sayHello = (): void => post({ type: "hello" });
  sayHello();
  opts.iframe.addEventListener("load", sayHello);

  return {
    setMode(mode: EmbedMode): void {
      post({ type: "setMode", mode });
    },
    clearSelection(): void {
      post({ type: "clearSelection" });
    },
    ready,
    destroy(): void {
      win.removeEventListener("message", onMessage);
      opts.iframe.removeEventListener("load", sayHello);
    },
  };
}
