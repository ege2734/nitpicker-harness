// @nitpicker/core — shared types. Framework-agnostic (no React). The wire schema mirrors the design's §8.2.

export type Mode = "cursor" | "region" | "element";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  w: number;
  h: number;
  dpr: number;
}

/** Descriptor for a picked element (element mode). The `resolveElement` host seam enriches this with
 *  React component name / source; core supplies the framework-agnostic fallback. */
export interface ElementDescriptor {
  component?: string;
  source?: string;
  testid?: string;
  selector?: string;
  tag?: string;
  role?: string;
  text?: string;
  rect?: Rect;
}

/** A queued feedback item. Serializes to the wire schema; fields prefixed `_` are client-only (the raw
 *  blob + a thumbnail) and are stripped by `serializeItem` before sending. */
export interface QueueItem {
  id: string;
  kind: "region" | "element" | "message";
  text: string;
  pageUrl: string;
  route?: string;
  viewport: Viewport;
  timestamp: string;
  image?: {
    ref?: string;
    path?: string;
    url?: string;
    mime: string;
    hasRedBox: boolean;
    selectionRect: Rect;
  };
  element?: ElementDescriptor;
  /** client-only: the composited PNG, uploaded as a binary blob on send (never base64 in JSON). */
  _blob?: Blob;
  /** client-only: a small data-URL thumbnail for the chat panel. */
  _thumb?: string;
}

export interface NitpickerOptions {
  /** project/session id → sidecar key. Match the `--session` you poll with. */
  session: string;
  /** sidecar base URL. Default http://127.0.0.1:5178. */
  endpoint?: string;
  /** host seam: framework-specific element enrichment (React name/source). */
  resolveElement?: (el: Element) => Partial<ElementDescriptor>;
  /** html2canvas scale; the red-box compositor uses the SAME value. Default = devicePixelRatio. */
  captureScale?: number;
}

export interface NitpickerHandle {
  unmount(): void;
}

/** Strip client-only fields before the item goes on the wire. */
export function serializeItem(item: QueueItem): Omit<QueueItem, "_blob" | "_thumb"> {
  const { _blob, _thumb, ...wire } = item;
  void _blob;
  void _thumb;
  return wire;
}
