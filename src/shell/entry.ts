// nitpicker-harness — the browser entry for the "builder shell" (viability report §6 / Phase 1+2). Unlike
// the injected overlay (src/overlay/entry.ts), this runs in the PARENT shell window (SHELL_PATH), a
// sibling of the same-origin `<iframe src="/">` that holds the proxied app. It owns the chat + queue +
// transport, so that state lives in the parent heap and survives ANY navigation the iframe does — SPA
// route change, hard reload, even a cross-origin excursion — with zero extra work (the iframe reloading
// never touches the parent). The markup is server-rendered by inject.ts:shellPage(); this file wires
// behavior onto it.
//
// Phase 2 adds the INTERACTIVE layer, all driven from the PARENT reading into the same-origin iframe:
//   • element pick — hover-outline + click-to-record (selector/text/rect/route + React component name),
//   • region + element screenshots — html2canvas run in the parent against the iframe content.
// The reused overlay engine (vendor/nitpicker/core) is parameterized over a DOM `Env` handle (env.ts), so
// captureRegion/baseDescriptor read the iframe's contentDocument/contentWindow while the highlight + red
// box render here in the parent. Geometry (the §5 single-offset rule) lives in ./geometry.
//
// Config (session + sidecar endpoint) rides on this script's own <script src> query string, exactly like
// the overlay, so no inline <script> is needed.
import { Transport } from "../../vendor/nitpicker/core/transport";
import { captureRegion } from "../../vendor/nitpicker/core/region";
import { baseDescriptor } from "../../vendor/nitpicker/core/elements";
import type { Env } from "../../vendor/nitpicker/core/env";
import { resolveReactElement } from "../../vendor/nitpicker/react/react-source";
import type { QueueItem, Rect, Viewport } from "../../vendor/nitpicker/core/types";
import { dragBox, elementRectInParent, parentPointToIframe } from "./geometry";

type Mode = "cursor" | "region" | "element";

function readConfig(): { session: string; endpoint: string } {
  const fallback = { session: "nitpicker", endpoint: "http://127.0.0.1:5178" };
  try {
    const cur = document.currentScript as HTMLScriptElement | null;
    const src = cur?.src;
    if (!src) return fallback;
    const params = new URL(src).searchParams;
    return {
      session: params.get("session") || fallback.session,
      endpoint: params.get("endpoint") || fallback.endpoint,
    };
  } catch {
    return fallback;
  }
}

function uuid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `np-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** The proxied app's current location, read across the same-origin iframe boundary. Falls back to the
 *  shell's own location when the iframe has wandered cross-origin (contentWindow.location then throws /
 *  reads null) — so queued items always carry a sensible route even mid-excursion. */
function iframeLocation(frame: HTMLIFrameElement | null): { href: string; route: string } {
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
function frameViewport(frame: HTMLIFrameElement | null): Viewport {
  const w = frame?.clientWidth || window.innerWidth;
  const h = frame?.clientHeight || window.innerHeight;
  return { w, h, dpr: window.devicePixelRatio || 1 };
}

/** The iframe's env (same-origin doc/window), or null when it's not ready or has gone cross-origin. This
 *  is the handle the parameterized engine reads against — element rects, the fiber walk, and html2canvas
 *  all target THIS document, while the highlight/red box render in the parent shell. */
function iframeEnv(frame: HTMLIFrameElement | null): Env | null {
  try {
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (doc && win && doc.body) return { doc, win };
  } catch {
    /* cross-origin — blocked */
  }
  return null;
}

class ShellChrome {
  private readonly transport: Transport;
  private queue: QueueItem[] = [];
  private sending = false;
  private mode: Mode = "cursor";

  private readonly frame = document.getElementById("nh-frame") as HTMLIFrameElement | null;
  private readonly queueEl = document.getElementById("nh-queue") as HTMLElement;
  private readonly countEl = document.getElementById("nh-count") as HTMLElement;
  private readonly inputEl = document.getElementById("nh-input") as HTMLTextAreaElement;
  private readonly queueBtn = document.getElementById("nh-queue-btn") as HTMLButtonElement;
  private readonly sendBtn = document.getElementById("nh-send-btn") as HTMLButtonElement;
  private readonly statusEl = document.getElementById("nh-status") as HTMLElement;
  private readonly modeBtns = new Map<Mode, HTMLButtonElement>();

  // Parent-hosted interaction layer (fixed over the iframe). See buildInteractionLayer.
  private overlayLayer!: HTMLElement;
  private highlightBox!: HTMLElement;
  private highlightLabel!: HTMLElement;
  private dragLayer!: HTMLElement;
  private dragOutline!: HTMLElement;

  // element-picker + drag state
  private hoverTarget: Element | null = null;
  private pickerDoc: Document | null = null; // the iframe doc the picker listeners are attached to
  private pickerWin: Window | null = null;
  private dragStart: { x: number; y: number } | null = null;
  private dragFrame: { left: number; top: number } | null = null;

  constructor(private readonly session: string, endpoint: string) {
    this.transport = new Transport(session, endpoint);
    this.buildInteractionLayer();
    this.wire();
    this.render();
  }

  private wire(): void {
    this.queueBtn.addEventListener("click", () => this.queueMessage());
    this.sendBtn.addEventListener("click", () => void this.send());
    this.inputEl.addEventListener("keydown", (e) => {
      // Enter queues; Shift+Enter inserts a newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.queueMessage();
      }
    });
    for (const mode of ["cursor", "region", "element"] as const) {
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
    // The iframe's rect only moves with a PARENT resize (its content scroll is handled per-doc); refit the
    // drag layer and reposition any live highlight when the shell window resizes.
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
    // Fixed, viewport-covering, click-through by default; children opt into pointer events per mode.
    layer.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483000;overflow:hidden;";

    // Element hover-outline (red — matches the region red box). pointer-events:none so hover still reaches
    // the iframe underneath. Positioned fixed in the PARENT viewport (geometry adds the iframe offset once).
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

    // Region drag surface — pointer-events:auto ONLY in region mode (fitDragLayer/setMode toggles it), sized
    // to the iframe rect so a drag never spills onto the sidebar. The red outline is drawn relative to it.
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
  private setMode(mode: Mode): void {
    if (mode === this.mode) return;
    // tear down the mode we're leaving
    this.disablePicker();
    this.clearDrag();
    this.hideHighlight();
    this.dragLayer.style.display = "none";
    this.dragLayer.style.pointerEvents = "none";

    this.mode = mode;
    for (const [m, btn] of this.modeBtns) btn.classList.toggle("nh-active", m === mode);

    if (mode === "element") this.enablePicker();
    else if (mode === "region") {
      this.fitDragLayer();
      this.dragLayer.style.display = "block";
      this.dragLayer.style.pointerEvents = "auto";
    }
  }

  private onFrameLoad(): void {
    // The old document is gone — drop any highlight and re-attach listeners to the new one if still picking.
    this.hideHighlight();
    this.hoverTarget = null;
    if (this.mode === "element") {
      this.disablePicker();
      this.enablePicker();
    } else if (this.mode === "region") {
      this.fitDragLayer();
    }
  }

  /** Size the region drag surface to the iframe's current rect in the parent viewport. */
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
      this.setStatus("App frame not ready for element pick.", "err");
      return;
    }
    this.pickerDoc = env.doc;
    this.pickerWin = env.win;
    // capture phase so we outline / swallow the click before the app's own handlers see it.
    env.doc.addEventListener("mouseover", this.onPickOver, true);
    env.doc.addEventListener("mouseout", this.onPickOut, true);
    env.doc.addEventListener("click", this.onPickClick, true);
    // Track the iframe's own scroll so the parent highlight follows the element.
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

  private onPickOver = (e: Event): void => {
    if (this.mode !== "element") return;
    const t = e.target as Element | null;
    if (!t || t.nodeType !== 1) {
      this.hideHighlight();
      return;
    }
    this.hoverTarget = t;
    this.showHighlight(t);
  };

  private onPickOut = (e: Event): void => {
    if (this.mode !== "element") return;
    // Left the iframe document entirely → drop the outline.
    if (!(e as MouseEvent).relatedTarget) this.hideHighlight();
  };

  private onPickClick = (e: Event): void => {
    if (this.mode !== "element") return;
    const t = e.target as Element | null;
    if (!t || t.nodeType !== 1) return;
    // Swallow the click so picking a link/button doesn't drive the app.
    e.preventDefault();
    e.stopPropagation();
    this.enqueueElement(t);
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
      this.setStatus("App frame not ready for capture.", "err");
      this.setMode("cursor");
      return;
    }
    // Parent drag corners → iframe-content coords (subtract the iframe offset ONCE — §5).
    const p0 = parentPointToIframe(start.x, start.y, frame);
    const p1 = parentPointToIframe(e.clientX, e.clientY, frame);
    const rect = clampRectToViewport(
      { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), w: Math.abs(p1.x - p0.x), h: Math.abs(p1.y - p0.y) },
      env.win,
    );
    if (rect.w < 6 || rect.h < 6) {
      // a click / tiny drag is a cancel
      this.setMode("cursor");
      return;
    }
    const scale = env.win.devicePixelRatio || 1;
    // Overlay UI lives in the PARENT, not the iframe, so there's no gutter to crop: capture the full frame
    // width. The dummy host is a detached parent node — never inside the iframe, so ignoreElements is a no-op.
    const dummyHost = document.createElement("div");
    const capture = captureRegion(rect, scale, dummyHost, env.win.innerWidth, env).then(
      ({ blob, thumb }) => ({ blob, thumb }),
    );
    this.enqueueRegion(rect, capture);
  };

  private updateDragOutline(curX: number, curY: number): void {
    if (!this.dragStart || !this.dragFrame) return;
    const box = dragBox(this.dragStart.x, this.dragStart.y, curX, curY);
    // The outline is absolute inside the drag layer, which sits at the iframe rect — so offset by that rect.
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

  // ---- queue ops ----
  /** Consume the compose box as the note for a region/element mark (so a typed note attaches to the next
   *  pick), or an empty note. */
  private takeNote(): string {
    const note = this.inputEl.value.trim();
    this.inputEl.value = "";
    return note;
  }

  private enqueueElement(target: Element): void {
    const descriptor = { ...baseDescriptor(target), ...resolveReactElement(target) };
    const { href, route } = iframeLocation(this.frame);
    this.queue.push({
      id: uuid(),
      kind: "element",
      text: this.takeNote(),
      pageUrl: href,
      route,
      viewport: frameViewport(this.frame),
      timestamp: new Date().toISOString(),
      element: descriptor,
    });
    this.setStatus("");
    this.render();
    this.setMode("cursor");
  }

  private enqueueRegion(rect: Rect, capture: Promise<{ blob: Blob; thumb: string }>): void {
    const { href, route } = iframeLocation(this.frame);
    const item: QueueItem = {
      id: uuid(),
      kind: "region",
      text: this.takeNote(),
      pageUrl: href,
      route,
      viewport: frameViewport(this.frame),
      timestamp: new Date().toISOString(),
      image: { mime: "image/png", hasRedBox: true, selectionRect: rect },
    };
    this.queue.push(item);
    item._pending = capture
      .then(({ blob, thumb }) => {
        item._blob = blob;
        item._thumb = thumb;
      })
      .catch((err: unknown) => {
        item._error = (err as Error).message;
        // Drop the mark rather than ship a red box with no screenshot.
        this.removeItem(item.id);
        this.setStatus(`Capture failed: ${item._error}`, "err");
      })
      .finally(() => {
        item._pending = undefined;
        this.render();
      });
    this.setStatus("");
    this.render();
    this.setMode("cursor");
  }

  private queueMessage(): void {
    const text = this.inputEl.value.trim();
    if (!text) return;
    const { href, route } = iframeLocation(this.frame);
    this.queue.push({
      id: uuid(),
      kind: "message",
      text,
      pageUrl: href,
      route,
      viewport: frameViewport(this.frame),
      timestamp: new Date().toISOString(),
    });
    this.inputEl.value = "";
    this.setStatus("");
    this.render();
    this.inputEl.focus();
  }

  private removeItem(id: string): void {
    this.queue = this.queue.filter((i) => i.id !== id);
    this.render();
  }

  private async send(): Promise<void> {
    if (this.sending || this.queue.length === 0) return;
    this.sending = true;
    const batch = this.queue.slice();
    const n = batch.length;
    this.render();
    this.setStatus(`Sending ${n} item${n === 1 ? "" : "s"}…`);
    try {
      // Region marks rasterize asynchronously — wait for any pending captures so every blob is attached.
      const pending = batch.map((i) => i._pending).filter(Boolean) as Promise<void>[];
      if (pending.length) {
        this.setStatus(`Finishing ${pending.length} screenshot${pending.length === 1 ? "" : "s"}…`);
        await Promise.all(pending);
      }
      // Never upload a region mark whose capture failed (no blob) — it would serialize as hasRedBox with
      // no screenshot. (A failed capture already removed itself, but guard belt-and-braces.)
      const uploadable = batch.filter((i) => !(i.kind === "region" && !i._blob));
      await this.transport.sendBatch(uploadable);
      this.queue = this.queue.filter((i) => !uploadable.includes(i));
      this.setStatus(`Sent ${uploadable.length} item${uploadable.length === 1 ? "" : "s"} to the agent.`, "ok");
    } catch (err) {
      this.setStatus(`Send failed: ${(err as Error).message}`, "err");
    } finally {
      this.sending = false;
      this.render();
    }
  }

  private setStatus(msg: string, kind?: "ok" | "err"): void {
    this.statusEl.textContent = msg;
    this.statusEl.className = `nh-status${kind ? ` nh-${kind}` : ""}`;
  }

  private render(): void {
    this.countEl.textContent = String(this.queue.length);
    this.sendBtn.disabled = this.sending || this.queue.length === 0;
    this.sendBtn.textContent = this.sending ? "Sending…" : "Send to agent";

    this.queueEl.textContent = "";
    if (this.queue.length === 0) {
      const empty = document.createElement("div");
      empty.className = "nh-empty";
      empty.textContent = "No feedback queued yet.";
      this.queueEl.appendChild(empty);
      return;
    }
    for (const item of this.queue) {
      const row = document.createElement("div");
      row.className = "nh-item";

      if (item.kind === "region") {
        const chip = document.createElement("span");
        chip.className = "nh-item-route";
        chip.textContent = item._thumb ? "region ✓" : item._error ? "region ✕" : "region · capturing…";
        row.appendChild(chip);
      } else if (item.kind === "element" && item.element) {
        const chip = document.createElement("span");
        chip.className = "nh-item-route";
        chip.textContent = item.element.component
          ? `⬡ ${item.element.component}`
          : item.element.selector ?? "element";
        row.appendChild(chip);
      }

      row.appendChild(document.createTextNode(item.text || "(no note)"));
      if (item.route) {
        const route = document.createElement("span");
        route.className = "nh-item-route";
        route.textContent = item.route;
        row.appendChild(route);
      }
      const del = document.createElement("button");
      del.className = "nh-del";
      del.type = "button";
      del.setAttribute("aria-label", "Remove");
      del.textContent = "×";
      del.addEventListener("click", () => this.removeItem(item.id));
      row.appendChild(del);
      this.queueEl.appendChild(row);
    }
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

// Read the config NOW, at synchronous module-execution time. `document.currentScript` is only non-null
// while the script is executing synchronously; if we deferred this read into a DOMContentLoaded callback
// (which fires when the end-of-body script ran during readyState === "loading"), currentScript would be
// null and we'd silently fall back to the default endpoint. So capture it here, once, and reuse it.
const CONFIG = readConfig();

function mount(): void {
  // The shell markup (from inject.ts:shellPage) must already be present. It always is: the injector places
  // this <script> at the end of <body>, after the chrome.
  if (!document.getElementById("nh-chat")) {
    console.error("[nitpicker-harness] shell chrome not found — is this the shell page?");
    return;
  }
  new ShellChrome(CONFIG.session, CONFIG.endpoint);
  console.info(
    "[nitpicker-harness] builder shell mounted. session:",
    CONFIG.session,
    "endpoint:",
    CONFIG.endpoint,
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
  mount();
}
