// @nitpicker/core — the overlay orchestrator: shadow-DOM UI, mode state machine, region drag/freeze
// flow, and the right-side chat panel. Framework-agnostic (no React). Mounted by a thin host glue
// (Next/React: ../react/dev-overlay.tsx). Public entry is Nitpicker.mount() in index.ts.
import { CSS } from "./styles";
import { Transport } from "./transport";
import { captureRegion, rasterizeViewport, annotateRegion } from "./region";
import { baseDescriptor } from "./elements";
import type { NitpickerHandle, NitpickerOptions, Mode, QueueItem, Rect, Viewport } from "./types";

const ICONS: Record<string, string> = {
  cursor: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 7-6 2-2 6z"/></svg>`,
  region: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 3"/></svg>`,
  element: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="3"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v11H9l-5 4z" stroke-linejoin="round"/></svg>`,
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}

function uuid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `np-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function viewport(): Viewport {
  return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
}

/** Normalize a drag (any direction) into a positive-size viewport rect in CSS px. */
function dragRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

export class Overlay implements NitpickerHandle {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly transport: Transport;
  private readonly scale: number;

  private mode: Mode = "cursor";
  private queue: QueueItem[] = [];
  private panelOpen = false;
  private sending = false;

  // DOM handles
  private dock!: HTMLElement;
  private interaction!: HTMLElement;
  private bands: HTMLElement[] = [];
  private outline!: HTMLElement;
  private elHighlight!: HTMLElement;
  private elLabel!: HTMLElement;
  private snapshot!: HTMLElement;
  private freeze!: HTMLElement;
  private panel!: HTMLElement;
  private listEl!: HTMLElement;
  private badgeEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private modeButtons = new Map<Mode, HTMLButtonElement>();

  // drag state
  private dragStart: { x: number; y: number } | null = null;
  // hotkey fast-path: viewport rasterized at key-press time so a hover-only element (tooltip/hover-card)
  // is frozen into the snapshot the user then draws a box on. null in the normal dock-button flow.
  private frozenCanvas: HTMLCanvasElement | null = null;
  // element-picker state
  private pickerOn = false;
  private prevBodyCursor: string | null = null;

  constructor(private readonly opts: NitpickerOptions) {
    this.scale = opts.captureScale ?? window.devicePixelRatio ?? 1;
    this.transport = new Transport(opts.session, opts.endpoint ?? "http://127.0.0.1:5178");

    this.host = el("div");
    this.host.setAttribute("data-nitpicker", "root");
    this.host.setAttribute("data-html2canvas-ignore", "true"); // never capture our own UI
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.appendChild(el("style", undefined, CSS));
    document.body.appendChild(this.host);

    this.build();
    document.addEventListener("keydown", this.onKeydown, true);
  }

  // ---- build DOM ----
  private build(): void {
    const rootEl = el("div", "np-root");

    // interaction (region drag) layer + its dim bands + outline
    this.interaction = el("div", "np-interaction");
    this.bands = ["top", "bottom", "left", "right"].map(() => el("div", "np-band"));
    this.outline = el("div", "np-outline");
    this.interaction.append(...this.bands, this.outline);
    this.interaction.addEventListener("mousedown", this.onDragStart);

    // element-picker highlight box (a separate overlay rect — we never mutate the host element's own
    // styles, so the app is never perturbed). Pointer-events:none so it can't eat clicks.
    this.elHighlight = el("div", "np-el-hl");
    this.elLabel = el("div", "np-el-hl-label");
    this.elHighlight.appendChild(this.elLabel);

    // snapshot layer: the hotkey fast-path paints its key-press-time viewport raster here so the drag
    // happens over a frozen image (hover-only UI preserved). Kept BELOW the interaction layer so the
    // dim bands + dashed outline still render on top of it while dragging.
    this.snapshot = el("div", "np-snapshot");

    // freeze layer (holds frozen canvas + queue card)
    this.freeze = el("div", "np-freeze");

    this.dock = this.buildDock();
    this.panel = this.buildPanel();

    rootEl.append(
      this.snapshot,
      this.interaction,
      this.elHighlight,
      this.freeze,
      this.dock,
      this.panel,
    );
    this.root.appendChild(rootEl);
    this.renderQueue();
  }

  private buildDock(): HTMLElement {
    const dock = el("div", "np-dock");
    const mkModeBtn = (mode: Mode, title: string, disabled = false): HTMLButtonElement => {
      const b = el("button", "np-btn", ICONS[mode]);
      b.title = title;
      b.disabled = disabled;
      if (disabled) b.appendChild(el("span", "np-soon", "soon"));
      if (!disabled) b.addEventListener("click", () => this.setMode(mode));
      this.modeButtons.set(mode, b);
      return b;
    };

    const chatBtn = el("button", "np-btn", ICONS.chat);
    chatBtn.title = "Feedback queue";
    this.badgeEl = el("span", "np-badge");
    chatBtn.appendChild(this.badgeEl);
    chatBtn.addEventListener("click", () => this.togglePanel());

    dock.append(
      mkModeBtn("cursor", "Cursor — passive (Esc)"),
      mkModeBtn("region", "Region — drag to screenshot (⌘/Ctrl+Shift+X freezes hover-only UI)"),
      mkModeBtn("element", "Element — hover to outline, click to record"),
      el("div", "np-sep"),
      chatBtn,
    );
    return dock;
  }

  private buildPanel(): HTMLElement {
    const panel = el("div", "np-panel");

    const head = el("div", "np-panel-head");
    head.append(el("span", undefined, "nitpicker feedback"));
    const close = el("button", "np-x", "✕");
    close.addEventListener("click", () => this.togglePanel(false));
    head.appendChild(close);

    this.listEl = el("div", "np-list");

    const foot = el("div", "np-panel-foot");
    const ta = el("textarea");
    ta.placeholder = "Add a message…";
    const addBtn = el("button", "np-ghost", "Add message");
    addBtn.addEventListener("click", () => {
      if (ta.value.trim()) {
        this.addMessage(ta.value.trim());
        ta.value = "";
      }
    });
    this.statusEl = el("div", "np-status");
    const sendBtn = el("button", "np-primary", "Send to agent");
    sendBtn.addEventListener("click", () => void this.send());
    foot.append(ta, addBtn, this.statusEl, sendBtn);

    panel.append(head, this.listEl, foot);
    return panel;
  }

  // ---- mode state machine ----
  private setMode(mode: Mode): void {
    this.mode = mode;
    for (const [m, btn] of this.modeButtons) btn.classList.toggle("np-active", m === mode);
    this.interaction.classList.toggle("np-armed", mode === "region");
    if (mode !== "region") {
      this.clearDrag();
      this.clearSnapshot();
    }
    if (mode === "element") this.enableElementPicker();
    else this.disableElementPicker();
  }

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      if (this.freeze.classList.contains("np-show")) this.unfreeze();
      this.setMode("cursor");
      return;
    }
    // Cmd/Ctrl+Shift+X — jump straight into Region mode from anywhere (any mode, any focus). We freeze
    // the viewport at THIS instant (before the cursor moves toward a drag) so hover-only UI — chart
    // hover-cards, tooltips, menus that vanish on mouse-move — is preserved in the snapshot the user
    // then boxes. Reaching for the dock's Region button can't do this: the mouse-move dismisses it.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "x") {
      e.preventDefault();
      this.enterRegionFrozen();
    }
  };

  /** Hotkey fast-path into Region mode: arm the drag synchronously, then freeze the current viewport. */
  private enterRegionFrozen(): void {
    // A capture card is already open (mid-queue) — ignore the hotkey rather than clobber it.
    if (this.freeze.classList.contains("np-show")) return;
    this.setMode("region"); // arm immediately so the mode reflects the keypress even before the raster
    void this.freezeViewport();
  }

  /** Rasterize the live viewport and paint it into the snapshot layer, freezing the (hovered) view. */
  private async freezeViewport(): Promise<void> {
    try {
      const { canvas } = await rasterizeViewport(this.scale, this.host);
      // The user may have bailed (Esc / mode switch) or already completed a capture while html2canvas
      // ran — don't resurrect the freeze on top of that.
      if (this.mode !== "region" || this.freeze.classList.contains("np-show")) return;
      this.frozenCanvas = canvas;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      this.snapshot.innerHTML = "";
      this.snapshot.appendChild(canvas);
      this.snapshot.classList.add("np-show");
    } catch (err) {
      console.error("nitpicker: region freeze failed", err);
      this.clearSnapshot();
      this.setStatus(`capture failed: ${(err as Error).message}`);
    }
  }

  // ---- region drag ----
  private onDragStart = (e: MouseEvent): void => {
    if (this.mode !== "region") return;
    e.preventDefault();
    this.dragStart = { x: e.clientX, y: e.clientY };
    for (const b of this.bands) b.style.display = "block";
    this.outline.style.display = "block";
    this.updateDrag(e.clientX, e.clientY);
    window.addEventListener("mousemove", this.onDragMove);
    window.addEventListener("mouseup", this.onDragEnd);
  };

  private onDragMove = (e: MouseEvent): void => {
    if (this.dragStart) this.updateDrag(e.clientX, e.clientY);
  };

  private onDragEnd = (e: MouseEvent): void => {
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
    if (!this.dragStart) return;
    const rect = dragRect(this.dragStart.x, this.dragStart.y, e.clientX, e.clientY);
    this.dragStart = null;
    if (rect.w < 6 || rect.h < 6) {
      this.clearDrag();
      return;
    }
    // Hotkey path: we already rasterized at key-press time — annotate that frozen canvas (do NOT
    // re-rasterize, which would capture the now-dismissed hover state). Dock path: rasterize now.
    if (this.frozenCanvas) void this.captureFromFrozen(rect);
    else void this.freezeAndCapture(rect);
  };

  private updateDrag(x1: number, y1: number): void {
    if (!this.dragStart) return;
    const r = dragRect(this.dragStart.x, this.dragStart.y, x1, y1);
    const [top, bottom, left, right] = this.bands;
    const set = (b: HTMLElement, x: number, y: number, w: number, h: number): void => {
      b.style.left = `${x}px`;
      b.style.top = `${y}px`;
      b.style.width = `${Math.max(0, w)}px`;
      b.style.height = `${Math.max(0, h)}px`;
    };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    set(top, 0, 0, vw, r.y);
    set(bottom, 0, r.y + r.h, vw, vh - (r.y + r.h));
    set(left, 0, r.y, r.x, r.h);
    set(right, r.x + r.w, r.y, vw - (r.x + r.w), r.h);
    Object.assign(this.outline.style, {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.w}px`,
      height: `${r.h}px`,
    });
  }

  private clearDrag(): void {
    for (const b of this.bands) b.style.display = "none";
    this.outline.style.display = "none";
    this.dragStart = null;
  }

  private clearSnapshot(): void {
    this.snapshot.classList.remove("np-show");
    this.snapshot.innerHTML = "";
    this.frozenCanvas = null;
  }

  private async freezeAndCapture(rect: Rect): Promise<void> {
    try {
      const { blob, canvas, thumb } = await captureRegion(rect, this.scale, this.host);
      this.clearDrag();
      // freeze: show the composited canvas at CSS viewport size
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      this.freeze.innerHTML = "";
      this.freeze.appendChild(canvas);
      this.freeze.classList.add("np-show");
      this.showQueueCard(rect, blob, thumb);
    } catch (err) {
      console.error("nitpicker: region capture failed", err);
      this.clearDrag();
      this.setStatus(`capture failed: ${(err as Error).message}`);
    }
  }

  /** Hotkey path: annotate the already-frozen (key-press-time) canvas — reused, never re-rasterized. */
  private async captureFromFrozen(rect: Rect): Promise<void> {
    const canvas = this.frozenCanvas;
    if (!canvas) return;
    try {
      const { blob, thumb } = await annotateRegion(canvas, rect, this.scale);
      this.clearDrag();
      // Promote the annotated snapshot canvas into the freeze layer + open the queue card, matching the
      // dock path's post-capture state. clearSnapshot() then just drops the (now-empty) backdrop + ref.
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      this.freeze.innerHTML = "";
      this.freeze.appendChild(canvas);
      this.freeze.classList.add("np-show");
      this.clearSnapshot();
      this.showQueueCard(rect, blob, thumb);
    } catch (err) {
      console.error("nitpicker: region capture failed", err);
      this.clearDrag();
      this.clearSnapshot();
      this.setStatus(`capture failed: ${(err as Error).message}`);
    }
  }

  private showQueueCard(rect: Rect, blob: Blob, thumb: string): void {
    // region already froze the view with an opaque canvas; reuse the shared card.
    this.openCard(rect, (text) => this.enqueueRegion(rect, blob, thumb, text));
  }

  /**
   * The shared "queue a message" card (one card, reused by both region and element). Anchored under
   * `anchor`, clamped into the viewport, hosted on the freeze layer. Region supplies its own opaque
   * canvas backdrop; element mode gets a transparent click-catching backdrop so app clicks behind the
   * card don't leak while it's open.
   */
  private openCard(
    anchor: Rect,
    onQueue: (text: string) => void,
    opts?: { backdrop?: boolean },
  ): void {
    const done = (): void => this.unfreeze();

    if (opts?.backdrop) {
      const back = el("div", "np-backdrop");
      back.addEventListener("click", done);
      this.freeze.appendChild(back);
    }

    const card = el("div", "np-card");
    const ta = el("textarea");
    ta.placeholder = "What should change here?";
    const actions = el("div", "np-actions");
    const cancel = el("button", "np-ghost", "Cancel");
    const queue = el("button", "np-primary", "Queue");
    actions.append(cancel, queue);
    card.append(ta, actions);

    // clamp near the anchor, inside the viewport
    const left = Math.min(anchor.x, window.innerWidth - 296);
    const top = Math.min(anchor.y + anchor.h + 8, window.innerHeight - 160);
    card.style.left = `${Math.max(8, left)}px`;
    card.style.top = `${Math.max(8, top)}px`;
    this.freeze.appendChild(card);
    this.freeze.classList.add("np-show");
    setTimeout(() => ta.focus(), 0);

    cancel.addEventListener("click", done);
    queue.addEventListener("click", () => {
      onQueue(ta.value.trim());
      done();
      this.togglePanel(true);
    });
  }

  // ---- element picker ----
  private enableElementPicker(): void {
    if (this.pickerOn) return;
    this.pickerOn = true;
    // capture phase: outline the element under the cursor before the app sees the event. Click is
    // intercepted so picking a button/link doesn't fire the app's handler.
    document.addEventListener("mouseover", this.onElementOver, true);
    document.addEventListener("mouseout", this.onElementOut, true);
    document.addEventListener("click", this.onElementClick, true);
    this.prevBodyCursor = document.body.style.cursor;
    document.body.style.cursor = "crosshair";
  }

  private disableElementPicker(): void {
    if (!this.pickerOn) return;
    this.pickerOn = false;
    document.removeEventListener("mouseover", this.onElementOver, true);
    document.removeEventListener("mouseout", this.onElementOut, true);
    document.removeEventListener("click", this.onElementClick, true);
    if (this.prevBodyCursor !== null) {
      document.body.style.cursor = this.prevBodyCursor;
      this.prevBodyCursor = null;
    }
    this.hideElHighlight();
  }

  /** The element under the cursor, or null for our own shadow-DOM UI (retargeted to the host). */
  private pickTarget(e: Event): Element | null {
    const t = e.target as Element | null;
    if (!t || t === this.host || t.nodeType !== 1) return null;
    return t;
  }

  private onElementOver = (e: MouseEvent): void => {
    if (this.mode !== "element" || this.cardOpen()) return;
    const target = this.pickTarget(e);
    if (!target) {
      this.hideElHighlight();
      return;
    }
    this.showElHighlight(target);
  };

  private onElementOut = (e: MouseEvent): void => {
    if (this.mode !== "element") return;
    // Left the document entirely (relatedTarget null) → drop the outline.
    if (!e.relatedTarget) this.hideElHighlight();
  };

  private onElementClick = (e: MouseEvent): void => {
    if (this.mode !== "element" || this.cardOpen()) return;
    const target = this.pickTarget(e);
    if (!target) return;
    // Swallow the click so picking (e.g.) a submit button or link doesn't trigger the app.
    e.preventDefault();
    e.stopPropagation();
    const descriptor = this.buildElementDescriptor(target);
    this.hideElHighlight();
    const anchor = descriptor?.rect ?? { x: e.clientX, y: e.clientY, w: 0, h: 0 };
    this.openCard(anchor, (text) => this.enqueueElement(descriptor, text), { backdrop: true });
  };

  private cardOpen(): boolean {
    return this.freeze.classList.contains("np-show");
  }

  private showElHighlight(target: Element): void {
    const r = target.getBoundingClientRect();
    Object.assign(this.elHighlight.style, {
      display: "block",
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    const tag = target.tagName.toLowerCase();
    const testid = target.getAttribute("data-testid") ?? target.getAttribute("data-test");
    this.elLabel.textContent = testid ? `${tag} · ${testid}` : tag;
  }

  private hideElHighlight(): void {
    this.elHighlight.style.display = "none";
  }

  private unfreeze(): void {
    this.freeze.classList.remove("np-show");
    this.freeze.innerHTML = "";
    this.clearSnapshot();
  }

  // ---- queue ops ----
  private enqueueRegion(rect: Rect, blob: Blob, thumb: string, text: string): void {
    this.queue.push({
      id: uuid(),
      kind: "region",
      text,
      pageUrl: location.href,
      route: location.pathname,
      viewport: viewport(),
      timestamp: new Date().toISOString(),
      image: { mime: "image/png", hasRedBox: true, selectionRect: rect },
      _blob: blob,
      _thumb: thumb,
    });
    this.renderQueue();
  }

  private enqueueElement(element: QueueItem["element"], text: string): void {
    this.queue.push({
      id: uuid(),
      kind: "element",
      text,
      pageUrl: location.href,
      route: location.pathname,
      viewport: viewport(),
      timestamp: new Date().toISOString(),
      element,
    });
    this.renderQueue();
  }

  private addMessage(text: string): void {
    this.queue.push({
      id: uuid(),
      kind: "message",
      text,
      pageUrl: location.href,
      route: location.pathname,
      viewport: viewport(),
      timestamp: new Date().toISOString(),
    });
    this.renderQueue();
  }

  /** Element-mode seam: core supplies the framework-agnostic base; the host `resolveElement` enriches
   *  it with React component name + source. */
  buildElementDescriptor(target: Element): QueueItem["element"] {
    const base = baseDescriptor(target);
    const extra = this.opts.resolveElement?.(target) ?? {};
    return { ...base, ...extra };
  }

  private removeItem(id: string): void {
    this.queue = this.queue.filter((i) => i.id !== id);
    this.renderQueue();
  }

  private renderQueue(): void {
    const n = this.queue.length;
    this.badgeEl.textContent = String(n);
    this.badgeEl.classList.toggle("np-show", n > 0);

    this.listEl.innerHTML = "";
    if (n === 0) {
      this.listEl.appendChild(
        el(
          "div",
          "np-empty",
          "No feedback queued yet.\nUse Region to screenshot, Element to pick a component, or add a message below.",
        ),
      );
      return;
    }
    for (const item of this.queue) {
      const row = el("div", "np-item");
      if (item.kind === "region" && item._thumb) {
        const img = el("img");
        img.src = item._thumb;
        row.appendChild(img);
      }
      const body = el("div", "np-item-body");
      body.appendChild(el("div", "np-item-kind", item.kind));
      const textEl = el("div", "np-item-text");
      textEl.textContent = item.text || "(no note)";
      body.appendChild(textEl);
      if (item.kind === "element" && item.element) {
        const chip = item.element.component ?? item.element.selector ?? "";
        if (chip) {
          const chipEl = el("div", "np-item-chip");
          chipEl.textContent = chip;
          body.appendChild(chipEl);
        }
      }
      const x = el("button", "np-x", "✕");
      x.addEventListener("click", () => this.removeItem(item.id));
      row.append(body, x);
      this.listEl.appendChild(row);
    }
  }

  // ---- panel + send ----
  private togglePanel(force?: boolean): void {
    this.panelOpen = force ?? !this.panelOpen;
    this.panel.classList.toggle("np-open", this.panelOpen);
    // shift the bottom-center dock clear of the right-side panel while it's open (styles.ts)
    this.dock.classList.toggle("np-shift", this.panelOpen);
  }

  private setStatus(msg: string): void {
    this.statusEl.textContent = msg;
  }

  private async send(): Promise<void> {
    if (this.sending || this.queue.length === 0) return;
    this.sending = true;
    const batch = this.queue;
    // optimistic clear; restore on failure
    this.queue = [];
    this.renderQueue();
    this.setStatus(`Sending ${batch.length}…`);
    try {
      await this.transport.sendBatch(batch);
      this.setStatus(`Sent ${batch.length} item(s) to agent.`);
    } catch (err) {
      this.queue = batch.concat(this.queue);
      this.renderQueue();
      this.setStatus(`Send failed: ${(err as Error).message}`);
    } finally {
      this.sending = false;
    }
  }

  // ---- teardown ----
  unmount(): void {
    document.removeEventListener("keydown", this.onKeydown, true);
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
    this.disableElementPicker();
    this.host.remove();
  }
}
