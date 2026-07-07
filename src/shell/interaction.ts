// nitpicker-harness — the reusable INTERACTION LAYER, extracted verbatim from the Phase-2 builder-shell
// (hz-agent §7). This is the parent-hosted machinery that reads the same-origin proxied `<iframe>` and turns
// user gestures into structured `QueueItem` marks: the mode toolbar (cursor/region/element/edit), the element
// picker (hover-outline + click → descriptor + React component name), region drag → html2canvas capture, and
// inline click-to-edit text. All of it runs in the PARENT window against the iframe's contentDocument via the
// reused engine's `Env` seam; the highlight/red-box render in the parent (the §5 single-offset geometry).
//
// It is SINK-AGNOSTIC: a completed mark is handed to `InteractionSink.onMark`. `ShellChrome` (src/shell/
// entry.ts) wires the sink to the sidecar `Transport`; `BuilderChrome` (src/builder/entry.ts) wires it to the
// Agent Gateway + a streaming transcript. The behavior is identical to the pre-extraction shell — guarded by
// tests/shell-geometry.test.ts + vendor env-seam.test.ts (the geometry + Env reads are unchanged).
import { captureRegion } from "../../vendor/nitpicker/core/region";
import { baseDescriptor } from "../../vendor/nitpicker/core/elements";
import type { Env } from "../../vendor/nitpicker/core/env";
import { resolveReactElement } from "../../vendor/nitpicker/react/react-source";
import type { ElementDescriptor, QueueItem, Rect, Viewport } from "../../vendor/nitpicker/core/types";
import { dragBox, elementRectInParent, parentPointToIframe } from "./geometry";

export type Mode = "cursor" | "region" | "element" | "edit";

/** What the interaction layer needs from its host: where to render marks, the note to attach, and status. */
export interface InteractionSink {
  /** Consume + clear the compose note to attach to the next pick (or "" for none). */
  takeNote(): string;
  /** A completed mark. For `region`, `_pending` is attached and resolves when the raster is ready. */
  onMark(item: QueueItem): void;
  /** Drop a mark the host is already showing (a region whose capture failed). */
  removeMark(id: string): void;
  /** Status line for the host chrome. */
  setStatus(msg: string, kind?: "ok" | "err"): void;
  /** Re-render after an async region capture settles (blob attached or dropped). */
  onCaptureSettled(): void;
}

function uuid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `np-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** The proxied app's current location, read across the same-origin iframe boundary. Falls back to the
 *  shell's own location when the iframe has wandered cross-origin. */
export function iframeLocation(frame: HTMLIFrameElement | null): { href: string; route: string } {
  try {
    const loc = frame?.contentWindow?.location;
    if (loc && loc.href && loc.href !== "about:blank") {
      return { href: loc.href, route: loc.pathname };
    }
  } catch {
    /* cross-origin iframe — DOM read is blocked; fall through to the shell's own location */
  }
  return { href: location.href, route: location.pathname };
}

/** Viewport of the app frame (the surface the feedback is about), best-effort. */
export function frameViewport(frame: HTMLIFrameElement | null): Viewport {
  const w = frame?.clientWidth || window.innerWidth;
  const h = frame?.clientHeight || window.innerHeight;
  return { w, h, dpr: window.devicePixelRatio || 1 };
}

/** The iframe's env (same-origin doc/window), or null when it's not ready or has gone cross-origin. */
export function iframeEnv(frame: HTMLIFrameElement | null): Env | null {
  try {
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (doc && win && doc.body) return { doc, win };
  } catch {
    /* cross-origin — blocked */
  }
  return null;
}

export class InteractionLayer {
  private mode: Mode = "cursor";
  private readonly frame = document.getElementById("nh-frame") as HTMLIFrameElement | null;
  private readonly modeBtns = new Map<Mode, HTMLButtonElement>();

  // Parent-hosted interaction DOM (fixed over the iframe).
  private overlayLayer!: HTMLElement;
  private highlightBox!: HTMLElement;
  private highlightLabel!: HTMLElement;
  private dragLayer!: HTMLElement;
  private dragOutline!: HTMLElement;

  // element-picker + drag state
  private hoverTarget: Element | null = null;
  private pickerDoc: Document | null = null;
  private pickerWin: Window | null = null;
  private dragStart: { x: number; y: number } | null = null;
  private dragFrame: { left: number; top: number } | null = null;

  // inline text-edit state (edit mode)
  private editingEl: HTMLElement | null = null;
  private editDescriptor: ElementDescriptor | null = null;
  private editOldText = "";
  private editOldHtml = "";
  private editCancelled = false;

  constructor(private readonly sink: InteractionSink) {
    this.buildInteractionLayer();
    this.wire();
  }

  private wire(): void {
    for (const mode of ["cursor", "region", "element", "edit"] as const) {
      const btn = document.getElementById(`nh-mode-${mode}`) as HTMLButtonElement | null;
      if (btn) {
        this.modeBtns.set(mode, btn);
        btn.addEventListener("click", () => this.setMode(mode));
      }
    }
    // Escape returns to passive cursor mode from anywhere.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.mode !== "cursor") this.setMode("cursor");
    });
    // The iframe's rect only moves with a PARENT resize; refit the drag layer + reposition any highlight.
    window.addEventListener("resize", () => {
      if (this.mode === "region") this.fitDragLayer();
      this.repositionHighlight();
    });
    // A navigation inside the iframe swaps its document: re-arm the active mode against the new one.
    this.frame?.addEventListener("load", () => this.onFrameLoad());
  }

  // ---- interaction layer DOM (parent) ----
  private buildInteractionLayer(): void {
    const layer = document.createElement("div");
    layer.id = "nh-overlay";
    layer.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483000;overflow:hidden;";

    const hl = document.createElement("div");
    hl.style.cssText =
      "position:fixed;display:none;pointer-events:none;box-sizing:border-box;" +
      "border:2px solid #ff3b30;background:rgba(255,59,48,.10);border-radius:2px;";
    const label = document.createElement("div");
    label.style.cssText =
      "position:absolute;left:-2px;top:-20px;max-width:60vw;overflow:hidden;text-overflow:ellipsis;" +
      "white-space:nowrap;padding:1px 6px;border-radius:4px;background:#ff3b30;color:#fff;" +
      "font:11px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
    hl.appendChild(label);

    const drag = document.createElement("div");
    drag.style.cssText =
      "position:fixed;display:none;pointer-events:none;cursor:crosshair;overflow:hidden;";
    const outline = document.createElement("div");
    outline.style.cssText =
      "position:absolute;display:none;box-sizing:border-box;border:2px solid #ff3b30;" +
      "background:rgba(255,59,48,.06);";
    drag.appendChild(outline);
    drag.addEventListener("mousedown", this.onDragStart);

    layer.append(drag, hl);
    document.body.appendChild(layer);
    this.overlayLayer = layer;
    this.highlightBox = hl;
    this.highlightLabel = label;
    this.dragLayer = drag;
    this.dragOutline = outline;
  }

  // ---- mode state machine ----
  setMode(mode: Mode): void {
    if (mode === this.mode) return;
    if (this.editingEl) this.commitEdit();
    this.disablePicker();
    this.clearDrag();
    this.hideHighlight();
    this.dragLayer.style.display = "none";
    this.dragLayer.style.pointerEvents = "none";

    this.mode = mode;
    for (const [m, btn] of this.modeBtns) btn.classList.toggle("nh-active", m === mode);

    if (mode === "element" || mode === "edit") this.enablePicker();
    else if (mode === "region") {
      this.fitDragLayer();
      this.dragLayer.style.display = "block";
      this.dragLayer.style.pointerEvents = "auto";
    }
  }

  private onFrameLoad(): void {
    this.hideHighlight();
    this.hoverTarget = null;
    this.editingEl = null;
    this.editDescriptor = null;
    if (this.mode === "element" || this.mode === "edit") {
      this.disablePicker();
      this.enablePicker();
    } else if (this.mode === "region") {
      this.fitDragLayer();
    }
  }

  private fitDragLayer(): void {
    if (!this.frame) return;
    const r = this.frame.getBoundingClientRect();
    Object.assign(this.dragLayer.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  // ---- element picker ----
  private enablePicker(): void {
    const env = iframeEnv(this.frame);
    if (!env) {
      this.sink.setStatus("App frame not ready for element pick.", "err");
      return;
    }
    this.pickerDoc = env.doc;
    this.pickerWin = env.win;
    env.doc.addEventListener("mouseover", this.onPickOver, true);
    env.doc.addEventListener("mouseout", this.onPickOut, true);
    env.doc.addEventListener("click", this.onPickClick, true);
    env.win.addEventListener("scroll", this.onFrameScroll, true);
    env.win.addEventListener("resize", this.repositionHighlight);
  }

  private disablePicker(): void {
    const doc = this.pickerDoc;
    const win = this.pickerWin;
    if (doc) {
      doc.removeEventListener("mouseover", this.onPickOver, true);
      doc.removeEventListener("mouseout", this.onPickOut, true);
      doc.removeEventListener("click", this.onPickClick, true);
    }
    if (win) {
      win.removeEventListener("scroll", this.onFrameScroll, true);
      win.removeEventListener("resize", this.repositionHighlight);
    }
    this.pickerDoc = null;
    this.pickerWin = null;
    this.hoverTarget = null;
  }

  private isPicking(): boolean {
    return this.mode === "element" || this.mode === "edit";
  }

  private onPickOver = (e: Event): void => {
    if (!this.isPicking() || this.editingEl) return;
    const t = e.target as Element | null;
    if (!t || t.nodeType !== 1) {
      this.hideHighlight();
      return;
    }
    this.hoverTarget = t;
    this.showHighlight(t);
  };

  private onPickOut = (e: Event): void => {
    if (!this.isPicking() || this.editingEl) return;
    if (!(e as MouseEvent).relatedTarget) this.hideHighlight();
  };

  private onPickClick = (e: Event): void => {
    if (!this.isPicking()) return;
    if (this.editingEl) return;
    const t = e.target as Element | null;
    if (!t || t.nodeType !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.mode === "edit") this.beginEdit(t);
    else this.enqueueElement(t);
  };

  private onFrameScroll = (): void => this.repositionHighlight();

  private showHighlight(target: Element): void {
    if (!this.frame) return;
    const box = elementRectInParent(target.getBoundingClientRect(), this.frame.getBoundingClientRect());
    Object.assign(this.highlightBox.style, {
      display: "block",
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    const tag = target.tagName.toLowerCase();
    const testid = target.getAttribute("data-testid") ?? target.getAttribute("data-test");
    this.highlightLabel.textContent = testid ? `${tag} · ${testid}` : tag;
  }

  private repositionHighlight = (): void => {
    if (this.mode === "element" && this.hoverTarget && this.highlightBox.style.display === "block") {
      this.showHighlight(this.hoverTarget);
    }
  };

  private hideHighlight(): void {
    this.highlightBox.style.display = "none";
  }

  // ---- region drag (parent surface → iframe capture) ----
  private onDragStart = (e: MouseEvent): void => {
    if (this.mode !== "region" || !this.frame) return;
    e.preventDefault();
    this.dragFrame = this.frame.getBoundingClientRect();
    this.dragStart = { x: e.clientX, y: e.clientY };
    this.dragOutline.style.display = "block";
    this.updateDragOutline(e.clientX, e.clientY);
    window.addEventListener("mousemove", this.onDragMove);
    window.addEventListener("mouseup", this.onDragEnd);
  };

  private onDragMove = (e: MouseEvent): void => {
    if (this.dragStart) this.updateDragOutline(e.clientX, e.clientY);
  };

  private onDragEnd = (e: MouseEvent): void => {
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
    const start = this.dragStart;
    const frame = this.dragFrame;
    this.dragStart = null;
    this.dragFrame = null;
    this.dragOutline.style.display = "none";
    if (!start || !frame) return;

    const env = iframeEnv(this.frame);
    if (!env) {
      this.sink.setStatus("App frame not ready for capture.", "err");
      this.setMode("cursor");
      return;
    }
    const p0 = parentPointToIframe(start.x, start.y, frame);
    const p1 = parentPointToIframe(e.clientX, e.clientY, frame);
    const rect = clampRectToViewport(
      { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), w: Math.abs(p1.x - p0.x), h: Math.abs(p1.y - p0.y) },
      env.win,
    );
    if (rect.w < 6 || rect.h < 6) {
      this.setMode("cursor");
      return;
    }
    const scale = env.win.devicePixelRatio || 1;
    const dummyHost = document.createElement("div");
    const capture = captureRegion(rect, scale, dummyHost, env.win.innerWidth, env).then(
      ({ blob, thumb }) => ({ blob, thumb }),
    );
    this.enqueueRegion(rect, capture);
  };

  private updateDragOutline(curX: number, curY: number): void {
    if (!this.dragStart || !this.dragFrame) return;
    const box = dragBox(this.dragStart.x, this.dragStart.y, curX, curY);
    Object.assign(this.dragOutline.style, {
      left: `${box.left - this.dragFrame.left}px`,
      top: `${box.top - this.dragFrame.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
  }

  private clearDrag(): void {
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
    this.dragStart = null;
    this.dragFrame = null;
    this.dragOutline.style.display = "none";
  }

  // ---- mark producers ----
  private enqueueElement(target: Element): void {
    const descriptor = { ...baseDescriptor(target), ...resolveReactElement(target) };
    const { href, route } = iframeLocation(this.frame);
    this.sink.onMark({
      id: uuid(),
      kind: "element",
      text: this.sink.takeNote(),
      pageUrl: href,
      route,
      viewport: frameViewport(this.frame),
      timestamp: new Date().toISOString(),
      element: descriptor,
    });
    this.sink.setStatus("");
    this.setMode("cursor");
  }

  // ---- inline text edit (edit mode) ----
  private beginEdit(target: Element): void {
    const el = target as HTMLElement;
    this.editDescriptor = { ...baseDescriptor(el), ...resolveReactElement(el) };
    this.editOldText = normText(el);
    this.editOldHtml = el.innerHTML;
    this.editCancelled = false;
    this.editingEl = el;
    this.hoverTarget = el;
    this.showHighlight(el);
    this.sink.setStatus("Editing text — Enter to save, Esc to cancel.");
    el.contentEditable = "true";
    el.setAttribute("data-nh-editing", "1");
    el.focus();
    selectAllText(el, this.pickerWin);
    el.addEventListener("keydown", this.onEditKey, true);
    el.addEventListener("blur", this.onEditBlur, true);
  }

  private onEditKey = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!e.shiftKey) (e.currentTarget as HTMLElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.editCancelled = true;
      (e.currentTarget as HTMLElement).blur();
    }
  };

  private onEditBlur = (): void => {
    this.commitEdit();
    this.setMode("cursor");
  };

  private commitEdit(): void {
    const el = this.editingEl;
    if (!el) return;
    this.editingEl = null;
    el.removeEventListener("keydown", this.onEditKey, true);
    el.removeEventListener("blur", this.onEditBlur, true);
    el.removeAttribute("contenteditable");
    el.removeAttribute("data-nh-editing");
    this.hideHighlight();

    const descriptor = this.editDescriptor;
    const oldText = this.editOldText;
    const cancelled = this.editCancelled;
    this.editDescriptor = null;

    if (cancelled) {
      el.innerHTML = this.editOldHtml;
      this.sink.setStatus("");
      return;
    }
    const newText = normText(el);
    if (newText === oldText) {
      el.innerHTML = this.editOldHtml;
      this.sink.setStatus("");
      return;
    }
    if (!descriptor) {
      this.sink.setStatus("");
      return;
    }
    this.enqueueTextEdit(descriptor, oldText, newText);
  }

  private enqueueTextEdit(descriptor: ElementDescriptor, oldText: string, newText: string): void {
    const { href, route } = iframeLocation(this.frame);
    this.sink.onMark({
      id: uuid(),
      kind: "text-edit",
      text: this.sink.takeNote(),
      pageUrl: href,
      route,
      viewport: frameViewport(this.frame),
      timestamp: new Date().toISOString(),
      element: descriptor,
      oldText,
      newText,
    });
    this.sink.setStatus(
      descriptor.source ? `Text edit queued · ${descriptor.source}` : "Text edit queued",
      "ok",
    );
  }

  private enqueueRegion(rect: Rect, capture: Promise<{ blob: Blob; thumb: string }>): void {
    const { href, route } = iframeLocation(this.frame);
    const item: QueueItem = {
      id: uuid(),
      kind: "region",
      text: this.sink.takeNote(),
      pageUrl: href,
      route,
      viewport: frameViewport(this.frame),
      timestamp: new Date().toISOString(),
      image: { mime: "image/png", hasRedBox: true, selectionRect: rect },
    };
    this.sink.onMark(item);
    item._pending = capture
      .then(({ blob, thumb }) => {
        item._blob = blob;
        item._thumb = thumb;
      })
      .catch((err: unknown) => {
        item._error = (err as Error).message;
        this.sink.removeMark(item.id);
        this.sink.setStatus(`Capture failed: ${item._error}`, "err");
      })
      .finally(() => {
        item._pending = undefined;
        this.sink.onCaptureSettled();
      });
    this.sink.setStatus("");
    this.setMode("cursor");
  }
}

/** Normalized visible text of a node — collapse whitespace + trim, so a whitespace-only edit is a no-op. */
export function normText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Select all of a contenteditable node's contents in the IFRAME so the first keystroke replaces the text. */
function selectAllText(el: HTMLElement, win: Window | null): void {
  if (!win) return;
  try {
    const range = win.document.createRange();
    range.selectNodeContents(el);
    const sel = win.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch {
    /* selection API unavailable / node detached — leave the caret as focus() placed it */
  }
}

/** Clamp a selection rect to the iframe viewport so a drag beyond the frame edge still captures cleanly. */
function clampRectToViewport(rect: Rect, win: Window): Rect {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const w = Math.min(rect.x + rect.w, win.innerWidth) - x;
  const h = Math.min(rect.y + rect.h, win.innerHeight) - y;
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}
