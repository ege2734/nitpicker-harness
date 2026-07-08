// nitpicker-harness — the InteractionSink that relays marks over the embed bridge instead of into a local
// queue. Split out of the browser entry (src/embed/entry.ts) so its relay logic — especially the async
// region-screenshot follow-up — is unit-testable without html2canvas or a real iframe.
//
// A region's screenshot rasterizes asynchronously (captureRegion), so `onMark` fires immediately with the
// serialized WireItem (no pixels) and `onCaptureSettled` follows once the raster resolves, relaying the blob
// via `mark-updated`. Element/text-edit marks are complete at `onMark` time. The persistent selection visual
// (red box + dimmed backdrop over the framed app) is kept — that's in-frame, same-origin — but the queue and
// annotate UI are left to the host.
import { serializeItem, type QueueItem } from "../../vendor/nitpicker/core/types";
import type { InteractionSink } from "../shell/interaction";
import type { ParentBox } from "../shell/geometry";
import type { WireItem } from "../agent/backend";

/** The subset of the bridge the sink relays through (EmbedBridge satisfies this structurally). */
export interface EmbedSinkBridge {
  emitMark(item: WireItem): void;
  emitMarkUpdated(id: string, image?: { mime: string; blob?: Blob; thumb?: string }, error?: string): void;
  emitMarkRemoved(id: string): void;
  emitStatus(message: string, kind?: "ok" | "err"): void;
}

/** Just the InteractionLayer method the sink drives (keeps the persistent selection up while the host
 *  composes its annotation). The full InteractionLayer satisfies this. */
export interface SelectionDriver {
  showSelection(anchor?: ParentBox): void;
}

export class EmbedSink implements InteractionSink {
  /** Set right after construction (the InteractionLayer needs `this` as its sink, and this sink needs the
   *  layer to drive the selection visual). Not used until a user gesture, well after wiring. */
  layer!: SelectionDriver;
  /** In-flight region marks, tracked so the resolved screenshot can be relayed once its raster settles. */
  private readonly regions = new Map<string, QueueItem>();

  constructor(private readonly bridge: EmbedSinkBridge) {}

  takeNote(): string {
    // The host owns the note/annotation step; marks cross the wire with only their descriptor.
    return "";
  }

  onMark(item: QueueItem, anchor?: ParentBox): void {
    this.bridge.emitMark(serializeItem(item));
    // Keep the classic "persist selection until commit" visual up over the framed app; the host clears it
    // (via a clearSelection command) once it has queued or discarded the mark.
    this.layer?.showSelection(anchor);
    if (item.kind === "region") this.regions.set(item.id, item);
  }

  removeMark(id: string): void {
    this.regions.delete(id);
    this.bridge.emitMarkRemoved(id);
  }

  onCaptureSettled(): void {
    for (const [id, item] of this.regions) {
      if (item._pending) continue; // still rasterizing
      if (item._blob) {
        // Raster succeeded: relay the full-res screenshot + a thumbnail for the host to render.
        this.bridge.emitMarkUpdated(id, {
          mime: item.image?.mime ?? "image/png",
          blob: item._blob,
          thumb: item._thumb,
        });
        this.regions.delete(id);
      } else if (item._error) {
        // Raster failed. The interaction layer already called removeMark() (→ `mark-removed`) before this
        // settle, so the host has withdrawn it; also relay the reason as a best-effort update, then stop
        // tracking. (Reached only if a caller settles a failed item WITHOUT removeMark.)
        this.bridge.emitMarkUpdated(id, undefined, item._error);
        this.regions.delete(id);
      }
      // else: settled callback fired before `_pending` was even attached — leave it tracked for the real settle.
    }
  }

  setStatus(msg: string, kind?: "ok" | "err"): void {
    this.bridge.emitStatus(msg, kind);
  }
}
