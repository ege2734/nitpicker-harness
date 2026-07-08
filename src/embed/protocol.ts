// nitpicker-harness — the CROSS-FRAME EMBED BRIDGE protocol. PURE + dependency-free (types + a couple of
// tiny validators), so both sides — the in-frame producer (src/embed/bridge.ts, run inside the harness's
// same-origin app frame) and the host-side helper (src/embed/client.ts, imported by Loom's own chrome) —
// speak the exact same schema, and it can be unit-tested without a DOM.
//
// The shape of the deployment (experience #3):
//
//   Loom host page (loom origin)                — renders its OWN chat rail / mode toolbar / queue
//     └─ <iframe> harness embed page (harness origin, src=/__nitpicker-harness/embed)
//          └─ <iframe id=nh-frame> the app (harness origin, proxied) — SAME-ORIGIN with the embed page
//
// The embed page runs the reused InteractionLayer against the app frame (same-origin → region/element/edit
// all work) but renders NO chrome of its own. It relays each produced mark UP to the Loom host over
// `postMessage`, and accepts a small command set (setMode / clearSelection / hello) DOWN from the host —
// origin-checked against a configured allow-list. This module is that wire contract.
import type { WireItem } from "../agent/backend";

/** Bumped only on a breaking schema change; both sides carry it on every message. */
export const EMBED_PROTOCOL_VERSION = 1;
/** `source` tag on every host→frame command (lets a frame ignore unrelated postMessage traffic). */
export const HOST_SOURCE = "nitpicker-embed-host";
/** `source` tag on every frame→host event (lets a host ignore unrelated postMessage traffic). */
export const FRAME_SOURCE = "nitpicker-embed";

/** The interaction modes the host can drive over the bridge — mirrors the InteractionLayer's `Mode`. */
export type EmbedMode = "cursor" | "region" | "element" | "edit";
export const EMBED_MODES: readonly EmbedMode[] = ["cursor", "region", "element", "edit"];

// ---- host → frame commands ----
export interface HelloCommand {
  source: typeof HOST_SOURCE;
  v: number;
  type: "hello";
}
export interface SetModeCommand {
  source: typeof HOST_SOURCE;
  v: number;
  type: "setMode";
  mode: EmbedMode;
}
export interface ClearSelectionCommand {
  source: typeof HOST_SOURCE;
  v: number;
  type: "clearSelection";
}
export type HostCommand = HelloCommand | SetModeCommand | ClearSelectionCommand;

// ---- frame → host events ----
/** Handshake: the embed bridge is mounted and ready to be driven. */
export interface ReadyEvent {
  source: typeof FRAME_SOURCE;
  v: number;
  type: "ready";
  modes: readonly EmbedMode[];
}
/** A mark was produced (element/region/text-edit). Carries the serialized `WireItem` — for a region the
 *  pixels are NOT here yet (they raster asynchronously); a follow-up `mark-updated` carries the screenshot. */
export interface MarkEvent {
  source: typeof FRAME_SOURCE;
  v: number;
  type: "mark";
  item: WireItem;
}
/** A region mark's screenshot finished rasterizing. `image.blob` is the full-res PNG (a structured-clonable
 *  `Blob`); `image.thumb` is a small data-URL preview. On failure `error` is set and `image` is absent. */
export interface MarkUpdatedEvent {
  source: typeof FRAME_SOURCE;
  v: number;
  type: "mark-updated";
  id: string;
  image?: { mime: string; blob?: Blob; thumb?: string };
  error?: string;
}
/** A mark the host was already shown is withdrawn (e.g. a region whose capture failed). */
export interface MarkRemovedEvent {
  source: typeof FRAME_SOURCE;
  v: number;
  type: "mark-removed";
  id: string;
}
/** A human-readable status line the host MAY surface (best-effort; the host owns its own chrome). */
export interface StatusEvent {
  source: typeof FRAME_SOURCE;
  v: number;
  type: "status";
  message: string;
  kind?: "ok" | "err";
}
export type FrameEvent = ReadyEvent | MarkEvent | MarkUpdatedEvent | MarkRemovedEvent | StatusEvent;

/** Omit that distributes over a discriminated union (plain `Omit` collapses a union to its shared keys). */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
/** A frame→host event minus the boilerplate envelope (`source`/`v`), which the bridge stamps on. */
export type FrameEventBody = DistributiveOmit<FrameEvent, "source" | "v">;
/** A host→frame command minus the boilerplate envelope (`source`/`v`), which the client stamps on. */
export type HostCommandBody = DistributiveOmit<HostCommand, "source" | "v">;

/** Narrow an unknown postMessage payload to a host→frame command (used by the in-frame bridge). */
export function isHostCommand(data: unknown): data is HostCommand {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { source?: unknown }).source === HOST_SOURCE &&
    typeof (data as { type?: unknown }).type === "string"
  );
}

/** Narrow an unknown postMessage payload to a frame→host event (used by the host-side client). */
export function isFrameEvent(data: unknown): data is FrameEvent {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { source?: unknown }).source === FRAME_SOURCE &&
    typeof (data as { type?: unknown }).type === "string"
  );
}

/** Is `mode` one of the known interaction modes? Guards a `setMode` command's payload. */
export function isEmbedMode(mode: unknown): mode is EmbedMode {
  return typeof mode === "string" && (EMBED_MODES as readonly string[]).includes(mode);
}

/**
 * Is `origin` in the trusted allow-list? This is the load-bearing security gate: commands are honored
 * ONLY from an origin the harness was configured to trust. Never trusts `"*"`, an empty entry, or an empty
 * origin (e.g. a `file:`/sandboxed frame reports `"null"`, which won't match a real https origin).
 */
export function originAllowed(origin: string, allow: readonly string[]): boolean {
  if (!origin) return false;
  return allow.some((o) => !!o && o !== "*" && o === origin);
}

/** Parse a comma-separated origins string (as carried on the embed bundle's `<script src>` query) into a
 *  clean allow-list — trimmed, de-duplicated, with empties and the unsafe `"*"` wildcard dropped. */
export function parseOrigins(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const o = part.trim();
    if (o && o !== "*") seen.add(o);
  }
  return [...seen];
}
