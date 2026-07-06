// @nitpicker/core — the overlay orchestrator: shadow-DOM UI, mode state machine, region drag/freeze
// flow, and the right-side chat panel. Framework-agnostic (no React). Mounted by a thin host glue
// (Next/React: ../react/dev-overlay.tsx). Public entry is Nitpicker.mount() in index.ts.
import { CSS } from "./styles";
import { Transport } from "./transport";
import { captureRegion, rasterizeViewport, annotateRegion } from "./region";
import { baseDescriptor } from "./elements";
import type { NitpickerHandle, NitpickerOptions, Mode, QueueItem, Rect, Viewport } from "./types";

// The docked feedback pane reserves this much width on the right; the host app reflows into the rest.
// Keep in sync with `--np-panel-w` in styles.ts. Below this viewport width the pane drops to a bottom
// sheet (media query) and reserves no horizontal width, so the app stays usable on narrow screens.
const PANE_W = 320;
const PANE_MIN_VIEWPORT = 720;
const PANE_STORAGE_KEY = "nitpicker:paneShown";

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

/** Object URL for a blob, or null where the API is unavailable (e.g. jsdom) so callers can fall back. */
function tryObjectURL(blob: Blob): string | null {
  try {
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
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
  // The chat pane is a DOCKED sidebar (not an overlay): when shown it reserves PANE_W of width and the
  // host app reflows beside it. Shown by default; the top-left toggle hides it and the dock's queue
  // button re-shows it. Persisted across reloads (localStorage), defaulting to shown.
  private paneShown = true;
  private sending = false;
  // Set once unmount() runs so a dock raster still in flight at teardown can't re-reserve the gutter when
  // its `.finally` fires maybeReconcileLayout() after the host (and restored <html> styles) are gone.
  private unmounted = false;
  // Saved host `<html>` inline styles so we can cleanly restore them on unmount (we set margin-right to
  // reserve the pane's gutter, plus a transition so the reflow animates).
  private prevHtmlMarginRight = "";
  private prevHtmlTransition = "";

  // DOM handles
  private dock!: HTMLElement;
  private interaction!: HTMLElement;
  private bands: HTMLElement[] = [];
  private outline!: HTMLElement;
  private elHighlight!: HTMLElement;
  private elLabel!: HTMLElement;
  private snapshot!: HTMLElement;
  private freezeCue!: HTMLElement;
  private freeze!: HTMLElement;
  private panel!: HTMLElement;
  private listEl!: HTMLElement;
  private badgeEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private modeButtons = new Map<Mode, HTMLButtonElement>();

  // drag state
  private dragStart: { x: number; y: number } | null = null;
  // hotkey fast-path ONLY: viewport rasterized at key-press time so a hover-only element (tooltip/hover-
  // card) is frozen into the snapshot the user then draws a box on. The dock path does NOT fill this — it
  // rasters at Queue-commit (captureRegionShot) and leaves these null; see CLAUDE.md (two raster timings).
  private frozenCanvas: HTMLCanvasElement | null = null;
  // the in-flight raster, kicked at key-press by the hotkey path. captureFromFrozen awaits it so the crop
  // always has the frozen canvas; usually already resolved by mouse-up → the card opens instantly.
  private freezePromise: Promise<void> | null = null;
  // cancels the pending (double-rAF-deferred) freeze raster if the user bails before it fires (Esc / mode
  // switch / unmount). Without this a scheduled raster would fire on a torn-down overlay. Null once the
  // raster has started (or was never scheduled).
  private cancelFreeze: (() => void) | null = null;
  // element-picker state
  private pickerOn = false;
  private prevBodyCursor: string | null = null;
  // cleanup for the open view/edit modal (e.g. revoke its object URL) — run by unfreeze()
  private modalCleanup: (() => void) | null = null;
  // count of dock-path rasters (captureRegionShot → captureRegion) still in flight. The pane must stay
  // reflow-locked for the FULL raster, not just while the queue card is open: html2canvas reads the live
  // DOM ~1–2s AFTER the card closes, so a pane toggle / window resize in that window would shift the app
  // out from under the fixed red-box coords + crop width. Ref-counted so overlapping captures each hold.
  private pendingDockRasters = 0;
  // the open region modal's body element + item id, so a Queue-time raster settling while the modal is
  // open can swap the "capturing…" placeholder for the finished screenshot in place — cleared by unfreeze()
  private modalRegionBody: { id: string; wrap: HTMLElement } | null = null;

  constructor(private readonly opts: NitpickerOptions) {
    this.scale = opts.captureScale ?? window.devicePixelRatio ?? 1;
    this.transport = new Transport(opts.session, opts.endpoint ?? "http://127.0.0.1:5178");
    this.paneShown = this.readPaneShown();

    const docEl = document.documentElement;
    this.prevHtmlMarginRight = docEl.style.marginRight;
    this.prevHtmlTransition = docEl.style.transition;

    this.host = el("div");
    this.host.setAttribute("data-nitpicker", "root");
    this.host.setAttribute("data-html2canvas-ignore", "true"); // never capture our own UI
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.appendChild(el("style", undefined, CSS));
    document.body.appendChild(this.host);

    this.build();
    // Reserve the pane's width on <html> so the host app renders in the remaining space, with a smooth
    // reflow. Only set the transition once (not per-toggle) to avoid clobbering any host transition mid-run.
    docEl.style.transition = ["margin-right .2s ease", this.prevHtmlTransition]
      .filter(Boolean)
      .join(", ");
    this.applyPaneLayout();
    document.addEventListener("keydown", this.onKeydown, true);
    window.addEventListener("resize", this.onResize);
  }

  private readPaneShown(): boolean {
    try {
      return window.localStorage.getItem(PANE_STORAGE_KEY) !== "0";
    } catch {
      return true; // storage blocked (private mode etc.) — default to shown
    }
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

    // instant "freezing viewport…" cue for the hotkey path — shown synchronously on the keypress so it
    // paints before the raster's main-thread block; hidden once the frozen snapshot lands (or on bail).
    this.freezeCue = el("div", "np-freeze-cue", "Freezing viewport…");

    // freeze layer (holds frozen canvas + queue card)
    this.freeze = el("div", "np-freeze");

    this.dock = this.buildDock();
    this.panel = this.buildPanel();

    rootEl.append(
      this.snapshot,
      this.freezeCue,
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
    chatBtn.title = "Feedback queue — show/hide the docked pane";
    this.badgeEl = el("span", "np-badge");
    chatBtn.appendChild(this.badgeEl);
    // The docked pane's own toggle can only HIDE it (it slides off with the pane); the dock button is the
    // always-visible affordance to bring it back, and carries the live queue-count badge.
    chatBtn.addEventListener("click", () => this.setPaneShown(!this.paneShown));

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
    // Hide/show toggle at the TOP-LEFT of the pane. Clicking it collapses the pane (removes the reserved
    // width → the app expands to full width). Reopen from the dock's queue button.
    const toggle = el("button", "np-pane-toggle", "⟩");
    toggle.title = "Hide feedback pane";
    toggle.addEventListener("click", () => this.setPaneShown(false));
    head.append(toggle, el("span", undefined, "nitpicker feedback"));

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
    // Show the "freezing viewport…" cue synchronously (before scheduling the raster) so it paints on the
    // next frame, ahead of the raster's main-thread block — the intrinsic ~1–2s freeze on a heavy DOM
    // then reads as a deliberate step, not a hang. Hidden when the snapshot lands or the user bails.
    this.freezeCue.classList.add("np-show");
    // Kick the raster on a LATER frame, never inline on the keypress. rasterizeViewport → html2canvas is
    // a single multi-hundred-ms (heavy DOM: ~1–2s) SYNCHRONOUS main-thread block that scale reduction
    // does not shrink (the cost is DOM traversal + style computation, not pixel fill). Running it inline
    // lands it in the keypress microtask, BEFORE the browser paints the armed mode UI — so the mode
    // switch appears to stall for the whole raster. Deferring past a paint (double rAF) lets the armed UI
    // render on the very next frame. We still fire within a couple frames — before the cursor can travel
    // to start a drag — so the hover-only UI (tooltips/hover-cards) is still frozen into the snapshot.
    this.freezePromise = this.scheduleFreeze();
  }

  /** Run {@link freezeViewport} after the mode-switch has had a frame to paint. Double rAF: the first
   *  callback fires just before the frame that paints the armed UI; the second fires on the frame after
   *  that, by which point the browser has committed the paint, so the raster's synchronous block no
   *  longer gates the mode switch. Falls back to a macrotask where rAF is unavailable (jsdom/tests). The
   *  pending schedule is stored in {@link cancelFreeze} so a bail-out (Esc/mode switch/unmount) before it
   *  fires cancels it — otherwise the raster would run on a torn-down overlay. */
  private scheduleFreeze(): Promise<void> {
    // A prior schedule still pending (double hotkey press) — drop it so only the latest raster runs.
    this.cancelFreeze?.();
    return new Promise<void>((resolve) => {
      const run = (): void => {
        this.cancelFreeze = null;
        void this.freezeViewport().then(resolve);
      };
      if (typeof requestAnimationFrame === "function") {
        let inner = 0;
        const outer = requestAnimationFrame(() => {
          inner = requestAnimationFrame(run);
        });
        this.cancelFreeze = () => {
          cancelAnimationFrame(outer);
          cancelAnimationFrame(inner);
        };
      } else {
        const t = setTimeout(run, 0);
        this.cancelFreeze = () => clearTimeout(t);
      }
    });
  }

  /** Rasterize the live viewport and paint it into the snapshot layer, freezing the (hovered) view. Used
   *  ONLY by the hotkey path — it must capture at key-press to preserve hover-only UI. The full viewport
   *  is rasterized (the pane is `ignoreElements`-excluded and its gutter is cropped off the final blob);
   *  the snapshot is shown at full width with the opaque docked pane sitting over the right gutter. */
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
      // Frozen view is now on screen — the "freezing…" step is done; the user draws over the snapshot.
      this.freezeCue.classList.remove("np-show");
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
    // Dock path: DO NOT rasterize here. The selection box is just an overlay rect drawn on the LIVE page,
    // so dragging is instant with no freeze. The screenshot is rasterized later, at Queue-commit time
    // (so a drag the user cancels never captures anything). The hotkey path is the exception — it froze
    // the viewport at key-press (frozenCanvas set) to preserve hover-only UI.
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
    // Clamp the selection to the app area so a box dragged toward the pane can't spill into its gutter.
    const rect = dragRect(this.dragStart.x, this.dragStart.y, this.clampX(e.clientX), e.clientY);
    this.dragStart = null;
    if (rect.w < 6 || rect.h < 6) {
      // A click (or too-small drag) in Region mode is a cancel — return to Cursor, the same outcome as
      // Esc. setMode("cursor") itself tears down the drag UI and any hotkey freeze snapshot.
      this.setMode("cursor");
      return;
    }
    if (this.frozenCanvas || this.freezePromise) {
      // Hotkey path: annotate the key-press-time frozen canvas (never re-rasterize — the hover state is
      // gone). The blob is ready by the time the card opens.
      void this.captureFromFrozen(rect);
    } else {
      // Dock path: open the queue card INSTANTLY over the live page (no freeze). The screenshot is
      // rasterized only if/when the user commits with Queue (enqueueRegion below), so a canceled drag
      // captures nothing.
      this.clearDrag();
      this.openCard(
        rect,
        (text) => this.enqueueRegion(rect, this.captureRegionShot(rect), text),
        { backdrop: true },
      );
    }
  };

  /** Clamp a viewport x-coordinate into the app area (0 … appWidth), keeping drags out of the pane. */
  private clampX(x: number): number {
    return Math.max(0, Math.min(x, this.appWidth()));
  }

  private updateDrag(x1: number, y1: number): void {
    if (!this.dragStart) return;
    const r = dragRect(this.dragStart.x, this.dragStart.y, this.clampX(x1), y1);
    const [top, bottom, left, right] = this.bands;
    const set = (b: HTMLElement, x: number, y: number, w: number, h: number): void => {
      b.style.left = `${x}px`;
      b.style.top = `${y}px`;
      b.style.width = `${Math.max(0, w)}px`;
      b.style.height = `${Math.max(0, h)}px`;
    };
    const vw = this.appWidth();
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
    // Kill any freeze raster still waiting on its deferral frames — the user bailed before it ran.
    this.cancelFreeze?.();
    this.cancelFreeze = null;
    this.freezeCue.classList.remove("np-show");
    this.snapshot.classList.remove("np-show");
    this.snapshot.innerHTML = "";
    this.frozenCanvas = null;
    this.freezePromise = null;
  }

  /** Dock path: rasterize + red-box the selection at Queue-commit time (viewport is unchanged since the
   *  draw — the card's backdrop kept the page from being interacted with). Returns the blob + thumbnail;
   *  the pane's gutter is cropped off inside {@link captureRegion} via appWidth.
   *
   *  Holds the pane reflow-lock for the FULL raster (released in the `.finally`), because captureRegion's
   *  html2canvas reads the DOM long after the card closes — see {@link pendingDockRasters}. NOTE: the
   *  residual scroll/animation desync inherent to ANY deferred raster (the page can scroll or animate
   *  between this Queue-commit and html2canvas finishing) is ACCEPTED and out of scope; only the pane's
   *  own appWidth reflow — which nitpicker itself introduces — is locked out. See AGENTS.md. */
  private captureRegionShot(rect: Rect): Promise<{ blob: Blob; thumb: string }> {
    this.pendingDockRasters++;
    return captureRegion(rect, this.scale, this.host, this.appWidth())
      .then(({ blob, thumb }) => ({ blob, thumb }))
      .finally(() => {
        this.pendingDockRasters--;
        this.setPaneLocked(this.paneLocked());
        this.maybeReconcileLayout();
      });
  }

  /**
   * Hotkey path: annotate the key-press-time frozen canvas (never re-rasterized — the hover state is
   * gone). If the raster is still in flight at mouse-up, await it first (usually already resolved).
   */
  private async captureFromFrozen(rect: Rect): Promise<void> {
    if (!this.frozenCanvas && this.freezePromise) {
      // freezeViewport swallows its own errors (clears the snapshot + sets a status), so this never
      // rejects — it just resolves with frozenCanvas still null, handled by the guard below.
      await this.freezePromise;
    }
    const canvas = this.frozenCanvas;
    if (!canvas) {
      // Raster failed (freezeViewport already reported it) — just drop the drag UI.
      this.clearDrag();
      return;
    }
    try {
      const { blob, thumb } = await annotateRegion(canvas, rect, this.scale, this.appWidth());
      this.clearDrag();
      // Promote the annotated snapshot canvas into the freeze layer + open the queue card. The frozen
      // blob is already ready, so the item is enqueued complete (no "capturing…" placeholder needed).
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      this.freeze.innerHTML = "";
      this.freeze.appendChild(canvas);
      this.freeze.classList.add("np-show");
      this.clearSnapshot();
      this.openCard(rect, (text) =>
        this.enqueueRegion(rect, Promise.resolve({ blob, thumb }), text),
      );
    } catch (err) {
      console.error("nitpicker: region capture failed", err);
      this.clearDrag();
      this.clearSnapshot();
      this.setStatus(`capture failed: ${(err as Error).message}`);
    }
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

    // clamp near the anchor, inside the app area (so the card never lands under the docked pane)
    const left = Math.min(anchor.x, this.appWidth() - 296);
    const top = Math.min(anchor.y + anchor.h + 8, window.innerHeight - 160);
    card.style.left = `${Math.max(8, left)}px`;
    card.style.top = `${Math.max(8, top)}px`;
    this.freeze.appendChild(card);
    this.freeze.classList.add("np-show");
    this.setPaneLocked(true);
    setTimeout(() => ta.focus(), 0);

    cancel.addEventListener("click", done);
    queue.addEventListener("click", () => {
      // Enqueue + close the card. The mark just appends to the always-visible docked pane's list and
      // ticks the dock badge (renderQueue) — no overlay pops over the page. The pane's shown/hidden
      // state is controlled only by its top-left toggle and the dock's queue button.
      onQueue(ta.value.trim());
      done();
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

  /** Make the docked pane visually inert while a card/modal is open: its controls (and the hide toggle)
   *  can't reflow the app underneath a pending capture. Released by unfreeze(). */
  private setPaneLocked(locked: boolean): void {
    this.panel.classList.toggle("np-locked", locked);
  }

  /** True while any appWidth-changing pane reflow must be suppressed: an open card/modal OR an in-flight
   *  dock raster (which outlives the card). Gates the pane toggle and window-resize reflow. */
  private paneLocked(): boolean {
    return this.cardOpen() || this.pendingDockRasters > 0;
  }

  /** Once the pane is fully unlocked, reapply the layout so a window resize that was suppressed during
   *  the lock window (onResize early-returns while locked) is reflected. */
  private maybeReconcileLayout(): void {
    if (!this.paneLocked()) this.applyPaneLayout();
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
    this.freeze.classList.remove("np-show", "np-over-pane");
    this.freeze.innerHTML = "";
    // Keep the visual dimming while a dock raster is still in flight — the functional lock (paneLocked)
    // outlives the card, so the pane must LOOK locked or its toggle silently no-ops.
    this.setPaneLocked(this.pendingDockRasters > 0);
    this.clearSnapshot();
    this.modalRegionBody = null;
    if (this.modalCleanup) {
      this.modalCleanup();
      this.modalCleanup = null;
    }
    // Closing the card/modal drops one lock holder; reconcile layout unless a dock raster still holds it.
    this.maybeReconcileLayout();
  }

  /**
   * View + edit a queued mark. Opens a modal (hosted on the freeze layer, so Esc/close/backdrop all tear
   * it down via unfreeze) showing the region screenshot (or the element descriptor), the message in an
   * editable field that saves back in place, and a Remove action.
   */
  private openItemModal(id: string): void {
    const item = this.queue.find((i) => i.id === id);
    if (!item || this.cardOpen()) return; // don't stack over an in-progress capture card
    this.freeze.innerHTML = "";
    const back = el("div", "np-backdrop");
    back.addEventListener("click", () => this.unfreeze());
    this.freeze.appendChild(back);

    const modal = el("div", "np-modal");
    const head = el("div", "np-modal-head");
    const title =
      item.kind === "region" ? "Region mark" : item.kind === "element" ? "Element mark" : "Message";
    const close = el("button", "np-x", "✕");
    close.addEventListener("click", () => this.unfreeze());
    head.append(el("span", undefined, title), close);
    modal.appendChild(head);

    const bodyWrap = el("div", "np-modal-body");
    if (item.kind === "region") {
      this.fillRegionBody(bodyWrap, item);
      this.modalRegionBody = { id: item.id, wrap: bodyWrap };
    } else if (item.kind === "element" && item.element) {
      const d = item.element;
      const lines = [
        d.component && `component: ${d.component}`,
        d.source && `source: ${d.source}`,
        d.selector && `selector: ${d.selector}`,
        d.testid && `testid: ${d.testid}`,
        d.tag && `tag: ${d.tag}`,
      ].filter(Boolean) as string[];
      bodyWrap.appendChild(el("div", "np-modal-desc", lines.join("\n") || "(element)"));
    }
    modal.appendChild(bodyWrap);

    const ta = el("textarea");
    ta.placeholder = "Message…";
    ta.value = item.text ?? "";
    modal.appendChild(ta);

    const actions = el("div", "np-actions");
    const remove = el("button", "np-ghost", "Remove");
    remove.addEventListener("click", () => {
      this.removeItem(item.id);
      this.unfreeze();
    });
    const save = el("button", "np-primary", "Save");
    save.addEventListener("click", () => {
      item.text = ta.value.trim();
      this.renderQueue();
      this.unfreeze();
    });
    actions.append(remove, save);
    modal.appendChild(actions);

    this.freeze.appendChild(modal);
    this.freeze.classList.add("np-show");
    // Raise the freeze layer (backdrop + modal) above the docked pane, which otherwise paints on top
    // (later in DOM order) and would obscure the modal's right edge — Save/Remove — on mid-width
    // viewports. The pane is locked while the modal is open, so a top-most modal is correct. NOT applied
    // to the capture card, which intentionally sits in the app area with the pane visible.
    this.freeze.classList.add("np-over-pane");
    this.setPaneLocked(true);
    setTimeout(() => ta.focus(), 0);
  }

  /**
   * Populate a region modal's body: the full-res blob (via an object URL we revoke on close), else the
   * small data-URL thumbnail, else a placeholder ("capturing…" while the raster runs, or a failure note).
   * Idempotent — clears the wrap first so it can re-run when a Queue-time raster settles under an open modal.
   */
  private fillRegionBody(wrap: HTMLElement, item: QueueItem): void {
    wrap.innerHTML = "";
    const url = item._blob ? tryObjectURL(item._blob) : null;
    const src = url ?? item._thumb ?? null;
    if (src) {
      const img = el("img", "np-modal-img");
      img.src = src;
      if (url) this.modalCleanup = () => URL.revokeObjectURL(url);
      wrap.appendChild(img);
    } else {
      wrap.appendChild(
        el("div", "np-modal-note", item._error ? "Screenshot capture failed." : "Capturing screenshot…"),
      );
    }
  }

  /** If the open modal is showing this region item, re-render its body in place once the raster settles. */
  private refreshModalRegion(id: string): void {
    if (this.modalRegionBody?.id !== id) return;
    const item = this.queue.find((i) => i.id === id);
    if (!item) return;
    if (this.modalCleanup) {
      this.modalCleanup();
      this.modalCleanup = null;
    }
    this.fillRegionBody(this.modalRegionBody.wrap, item);
  }

  // ---- queue ops ----
  /**
   * Enqueue a region mark. `capture` resolves to the composited blob + thumbnail: on the dock path it's
   * the raster kicked off at THIS Queue-commit moment (async), on the hotkey path it's already resolved.
   * The item is pushed immediately (badge ticks now) and shows a "capturing…" placeholder in the pane
   * until the blob lands; `send()` awaits `_pending` so the blob is always attached before upload.
   */
  private enqueueRegion(
    rect: Rect,
    capture: Promise<{ blob: Blob; thumb: string }>,
    text: string,
  ): void {
    const item: QueueItem = {
      id: uuid(),
      kind: "region",
      text,
      pageUrl: location.href,
      route: location.pathname,
      viewport: viewport(),
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
        console.error("nitpicker: region capture failed", err);
        // Drop the mark entirely rather than upload a region with a red box but no screenshot — matches
        // the old freeze path, where a dock-capture failure left no mark behind.
        this.removeItem(item.id);
        this.setStatus(`capture failed: ${item._error}`);
      })
      .finally(() => {
        item._pending = undefined;
        this.renderQueue();
        this.refreshModalRegion(item.id);
      });
    this.renderQueue();
    // Snap back to Cursor after a completed Region mark so the user is returned to normal page
    // interaction (the freeze/snapshot, if any, is torn down and the page is live again).
    this.setMode("cursor");
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
    // Mirror the Region flow: return to Cursor after a completed Element mark for a consistent
    // "one mark → back to normal interaction" model (the picker's crosshair/listeners are torn down).
    this.setMode("cursor");
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
      if (item.kind === "region") {
        if (item._thumb) {
          const img = el("img");
          img.src = item._thumb;
          row.appendChild(img);
        } else {
          // raster still in flight (dock path rasterizes at Queue), or it failed
          row.appendChild(el("div", "np-item-thumb-ph", item._error ? "✕" : "…"));
        }
      }
      const body = el("div", "np-item-body");
      body.appendChild(el("div", "np-item-kind", item.kind));
      const textEl = el("div", "np-item-text");
      textEl.textContent = item.text || "(no note)";
      body.appendChild(textEl);
      if (item.kind === "region" && !item._thumb) {
        body.appendChild(
          el("div", "np-item-chip", item._error ? `capture failed` : "capturing…"),
        );
      }
      if (item.kind === "element" && item.element) {
        const chip = item.element.component ?? item.element.selector ?? "";
        if (chip) {
          const chipEl = el("div", "np-item-chip");
          chipEl.textContent = chip;
          body.appendChild(chipEl);
        }
      }
      const x = el("button", "np-x", "✕");
      x.addEventListener("click", (e) => {
        e.stopPropagation(); // don't also open the view/edit modal
        this.removeItem(item.id);
      });
      // Click the row (anywhere but the ✕) to view + edit the mark in a modal.
      row.addEventListener("click", () => this.openItemModal(item.id));
      row.append(body, x);
      this.listEl.appendChild(row);
    }
  }

  // ---- docked pane layout + send ----
  /** Width reserved on the right for the docked pane — 0 when hidden, or on narrow viewports where the
   *  pane drops to a bottom sheet (media query) and reserving horizontal width would crush the app. */
  private reservedWidth(): number {
    return this.paneShown && window.innerWidth > PANE_MIN_VIEWPORT ? PANE_W : 0;
  }

  /** The app's rendered area width — the full viewport minus the pane's reserved gutter. Region capture
   *  and the drag selection are both confined to this so a screenshot never includes the pane. */
  private appWidth(): number {
    return window.innerWidth - this.reservedWidth();
  }

  private setPaneShown(shown: boolean): void {
    // A capture card/modal is open OR a dock raster is still in flight: toggling the pane now would reflow
    // the app (change appWidth) while a screenshot is pending, desyncing the red box from what was
    // selected. The lock spans the FULL raster, not just the card's lifetime (see paneLocked). Ignore it.
    if (this.paneLocked()) return;
    this.paneShown = shown;
    try {
      window.localStorage.setItem(PANE_STORAGE_KEY, shown ? "1" : "0");
    } catch {
      /* storage blocked — state simply won't persist */
    }
    this.applyPaneLayout();
  }

  /** Reflect `paneShown` into the DOM: slide the pane in/out, reserve (or release) the app's right gutter,
   *  keep the bottom-center dock centered over the app area, and confine the region drag layer. */
  private applyPaneLayout(): void {
    if (this.unmounted) return; // a late raster `.finally` must not re-reserve the gutter after teardown
    const reserve = this.reservedWidth();
    this.panel.classList.toggle("np-shown", this.paneShown);
    // Shift on paneShown, NOT `reserve > 0`: on narrow viewports the pane is a bottom sheet reserving 0
    // width, but the dock still must lift above it (the narrow media-query `.np-dock.np-shift` rule).
    // Wide → left-shift over the app area; narrow → lift above the 70vh sheet.
    this.dock.classList.toggle("np-shift", this.paneShown);
    document.documentElement.style.marginRight = reserve
      ? `${reserve}px`
      : this.prevHtmlMarginRight;
    // keep the region drag layer (and its dim bands) out of the pane's gutter
    this.interaction.style.right = `${reserve}px`;
  }

  private onResize = (): void => {
    // Don't reflow the app while a card/modal is open or a dock raster is in flight — an appWidth change
    // would desync the pending screenshot. maybeReconcileLayout() catches up once the lock releases.
    if (this.paneLocked()) return;
    this.applyPaneLayout();
  };

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
      // Region marks rasterize at Queue-time (dock path) — a mark's blob may still be in flight. Wait for
      // any pending captures so every region blob is attached before we upload (guaranteed, per the brief).
      const pending = batch.map((i) => i._pending).filter(Boolean) as Promise<void>[];
      if (pending.length) {
        this.setStatus(`Finishing ${pending.length} screenshot(s)…`);
        await Promise.all(pending);
      }
      // Belt-and-braces: never upload a region mark whose capture failed (no blob) — it would serialize
      // as hasRedBox:true with no screenshot and no failure signal.
      const uploadable = batch.filter((i) => !(i.kind === "region" && !i._blob));
      await this.transport.sendBatch(uploadable);
      this.setStatus(`Sent ${uploadable.length} item(s) to agent.`);
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
    this.unmounted = true;
    document.removeEventListener("keydown", this.onKeydown, true);
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
    window.removeEventListener("resize", this.onResize);
    // tear down any open card/modal so its object URL (item screenshot) is revoked, not leaked
    this.unfreeze();
    // release the reserved gutter — restore the host <html> inline styles exactly as we found them
    document.documentElement.style.marginRight = this.prevHtmlMarginRight;
    document.documentElement.style.transition = this.prevHtmlTransition;
    this.disableElementPicker();
    this.host.remove();
  }
}
