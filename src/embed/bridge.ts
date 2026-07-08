// nitpicker-harness — the IN-FRAME half of the cross-frame embed bridge. Runs inside the harness's embed
// page (same-origin with the proxied app), listens for origin-checked host commands over `postMessage`, and
// relays produced marks + lifecycle events back UP to the trusted host. It is DOM-light: it touches only
// `window`/`postMessage`, not the InteractionLayer (entry.ts wires the two together), so it unit-tests
// without html2canvas or a real iframe.
//
// Security: every inbound message is gated by `originAllowed(ev.origin, allowedOrigins)` — a command from an
// untrusted origin is dropped silently. Outbound events are posted with an EXPLICIT target origin (the
// confirmed host), NEVER `"*"`. The "confirmed host" is learned from the first trusted inbound message (or
// defaults to the sole configured origin), so a mark — which can only follow a `setMode` command — always
// has a known, trusted destination.
import {
  EMBED_MODES,
  EMBED_PROTOCOL_VERSION,
  FRAME_SOURCE,
  isEmbedMode,
  isHostCommand,
  originAllowed,
  type EmbedMode,
  type FrameEvent,
  type FrameEventBody,
} from "./protocol";
import type { WireItem } from "../agent/backend";

export interface EmbedBridgeOptions {
  /** Origins the harness is configured to trust as the host (Loom). Commands from anything else are dropped. */
  allowedOrigins: readonly string[];
  /** Apply a host `setMode` command (wired to InteractionLayer.setMode). */
  onSetMode: (mode: EmbedMode) => void;
  /** Apply a host `clearSelection` command (wired to InteractionLayer.clearSelection). */
  onClearSelection: () => void;
  /** The window to receive commands on. Default: the ambient `window`. */
  window?: Window;
  /** The window to post events to (the host). Default: `window.parent`. */
  parent?: Window;
}

export class EmbedBridge {
  private readonly win: Window;
  private readonly parent: Window;
  private readonly trusted: string[];
  /** The confirmed host origin for outbound posts. Set from the first trusted inbound message; defaults to
   *  the sole configured origin so a single-host deployment can announce `ready` before any command. */
  private activeOrigin: string | null;

  constructor(private readonly opts: EmbedBridgeOptions) {
    this.win = opts.window ?? window;
    this.parent = opts.parent ?? window.parent;
    this.trusted = opts.allowedOrigins.filter((o) => !!o && o !== "*");
    this.activeOrigin = this.trusted.length === 1 ? this.trusted[0] : null;
    this.win.addEventListener("message", this.onMessage);
    // Announce readiness proactively so a host that mounted BEFORE us still learns we're live. When there are
    // multiple trusted origins we don't yet know which framed us, so we announce to each (target-origin scoped,
    // so only a trusted host can actually receive it).
    this.emitReady();
  }

  private onMessage = (ev: MessageEvent): void => {
    if (!originAllowed(ev.origin, this.trusted)) return;
    if (!isHostCommand(ev.data)) return;
    // Lock outbound posts to the confirmed host that just spoke to us.
    this.activeOrigin = ev.origin;
    switch (ev.data.type) {
      case "hello":
        this.emitReady();
        break;
      case "setMode":
        if (isEmbedMode(ev.data.mode)) this.opts.onSetMode(ev.data.mode);
        break;
      case "clearSelection":
        this.opts.onClearSelection();
        break;
    }
  };

  // ---- outbound events (frame → host) ----
  emitReady(): void {
    this.send({ type: "ready", modes: EMBED_MODES });
  }

  emitMark(item: WireItem): void {
    this.send({ type: "mark", item });
  }

  emitMarkUpdated(id: string, image?: { mime: string; blob?: Blob; thumb?: string }, error?: string): void {
    this.send({ type: "mark-updated", id, image, error });
  }

  emitMarkRemoved(id: string): void {
    this.send({ type: "mark-removed", id });
  }

  emitStatus(message: string, kind?: "ok" | "err"): void {
    this.send({ type: "status", message, kind });
  }

  destroy(): void {
    this.win.removeEventListener("message", this.onMessage);
  }

  /** Post an event to the confirmed host, or (before any command) broadcast to every trusted origin. Target
   *  origins are always explicit — never `"*"`. */
  private send(body: FrameEventBody): void {
    const msg = { source: FRAME_SOURCE, v: EMBED_PROTOCOL_VERSION, ...body } as FrameEvent;
    const targets = this.activeOrigin ? [this.activeOrigin] : this.trusted;
    for (const origin of targets) {
      try {
        this.parent.postMessage(msg, origin);
      } catch {
        /* a torn-down parent / detached frame — nothing to relay to */
      }
    }
  }
}
