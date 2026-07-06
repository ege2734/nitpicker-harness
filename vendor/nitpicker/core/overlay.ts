// @nitpicker/core — the overlay orchestrator: shadow-DOM UI, mode state machine, region drag/freeze
// flow, and the right-side chat panel. Framework-agnostic (no React). Mounted by a thin host glue
// (Next/React: ../react/dev-overlay.tsx). Public entry is Nitpicker.mount() in index.ts.
import { CSS } from "./styles";
import { Transport } from "./transport";
import { captureRegion, annotateRegion, buildFrozenClone, rasterizeFrozen } from "./region";
import type { FrozenSnapshot } from "./region";
import { baseDescriptor } from "./elements";
import { ambientEnv, type Env } from "./env";
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

// Create an element in a specific document — the env's document, so the overlay's DOM is built in the
// same document it renders into (ambient in injected mode). See {@link Overlay.el}.
function createEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}

function uuid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `np-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
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
  // The DOM environment the engine reads + renders against (see env.ts). Ambient in injected mode; the
  // shell would pass the proxied iframe's env. All DOM-global access below routes through it (this.env).
  private readonly env: Env;

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
  // Cached viewport width EXCLUDING a classic scrollbar's gutter (documentElement.clientWidth). appWidth()
  // reads this instead of innerWidth so the frozen-region clone, drag clamp, dim bands, and pane crop all
  // reproduce the live app's content box exactly — otherwise the clone is scrollbarWidth px too wide and
  // the opaque frozen snapshot appears shifted vs the live page it replaces (Issue 1). Overlay scrollbars
  // (0 width, e.g. macOS default) make it identical to innerWidth, so this is a no-op there. Cached +
  // refreshed only at moments the geometry can change (mount, resize, drag/freeze entry) so the per-frame
  // drag path never forces a layout read. Falls back to innerWidth when clientWidth is 0 (jsdom/pre-layout).
  private viewportContentW = 0;

  // DOM handles
  private dock!: HTMLElement;
  private interaction!: HTMLElement;
  private bands: HTMLElement[] = [];
  private outline!: HTMLElement;
  private elHighlight!: HTMLElement;
  private elLabel!: HTMLElement;
  private freeze!: HTMLElement;
  private panel!: HTMLElement;
  private listEl!: HTMLElement;
  private badgeEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private modeButtons = new Map<Mode, HTMLButtonElement>();

  // drag state
  private dragStart: { x: number; y: number } | null = null;
  // hotkey fast-path ONLY: a CHEAP DOM clone of the live viewport, built + attached synchronously at
  // key-press (~one frame) so a hover-only element (tooltip/hover-card) is frozen before the cursor moves.
  // Unlike the old path this does NOT rasterize here — the (~1–2s) html2canvas raster is deferred to
  // drag-end and reads this clone. Null on the dock path (which draws on the live page and rasters at
  // Queue-commit). Set at key-press; moved to an in-flight-raster local at drag-end. See region.ts.
  private frozenSnapshot: FrozenSnapshot | null = null;
  // The frozen clone's holder once a drag has committed it as the card's backdrop (drag-end → card close).
  // Distinct from {@link frozenSnapshot} (the pre-drag drawing phase): removed on card close if no raster
  // is consuming it, else by the raster's `.finally` (which needs it attached for html2canvas).
  private frozenHolder: HTMLElement | null = null;
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
    this.env = opts.env ?? ambientEnv();
    this.scale = opts.captureScale ?? this.env.win.devicePixelRatio ?? 1;
    this.transport = new Transport(opts.session, opts.endpoint ?? "http://127.0.0.1:5178");
    this.paneShown = this.readPaneShown();
    this.measureViewport();

    const docEl = this.env.doc.documentElement;
    this.prevHtmlMarginRight = docEl.style.marginRight;
    this.prevHtmlTransition = docEl.style.transition;

    this.host = this.el("div");
    this.host.setAttribute("data-nitpicker", "root");
    this.host.setAttribute("data-html2canvas-ignore", "true"); // never capture our own UI
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.appendChild(this.el("style", undefined, CSS));
    this.env.doc.body.appendChild(this.host);

    this.build();
    // Reserve the pane's width on <html> so the host app renders in the remaining space, with a smooth
    // reflow. Only set the transition once (not per-toggle) to avoid clobbering any host transition mid-run.
    docEl.style.transition = ["margin-right .2s ease", this.prevHtmlTransition]
      .filter(Boolean)
      .join(", ");
    this.applyPaneLayout();
    this.env.doc.addEventListener("keydown", this.onKeydown, true);
    this.env.win.addEventListener("resize", this.onResize);
  }

  /** Create an element in the env's document (so the overlay DOM lives in the document it renders into). */
  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    html?: string,
  ): HTMLElementTagNameMap[K] {
    return createEl(this.env.doc, tag, cls, html);
  }

  /** The env window's viewport (the surface the feedback is about). */
  private viewport(): Viewport {
    const w = this.env.win;
    return { w: w.innerWidth, h: w.innerHeight, dpr: w.devicePixelRatio || 1 };
  }

  private readPaneShown(): boolean {
    try {
      return this.env.win.localStorage.getItem(PANE_STORAGE_KEY) !== "0";
    } catch {
      return true; // storage blocked (private mode etc.) — default to shown
    }
  }

  // ---- build DOM ----
  private build(): void {
    const rootEl = this.el("div", "np-root");

    // interaction (region drag) layer + its dim bands + outline
    this.interaction = this.el("div", "np-interaction");
    this.bands = ["top", "bottom", "left", "right"].map(() => this.el("div", "np-band"));
    this.outline = this.el("div", "np-outline");
    this.interaction.append(...this.bands, this.outline);
    this.interaction.addEventListener("mousedown", this.onDragStart);

    // element-picker highlight box (a separate overlay rect — we never mutate the host element's own
    // styles, so the app is never perturbed). Pointer-events:none so it can't eat clicks.
    this.elHighlight = this.el("div", "np-el-hl");
    this.elLabel = this.el("div", "np-el-hl-label");
    this.elHighlight.appendChild(this.elLabel);

    // freeze layer (holds the queue card / view-edit modal). The hotkey fast-path's frozen visual is a
    // cheap DOM clone attached to the LIGHT DOM (so the page's own stylesheets re-apply to it) — not a
    // shadow-DOM canvas — so it does not live here; see enterRegionFrozen / region.ts buildFrozenClone.
    this.freeze = this.el("div", "np-freeze");

    this.dock = this.buildDock();
    this.panel = this.buildPanel();

    rootEl.append(
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
    const dock = this.el("div", "np-dock");
    const mkModeBtn = (mode: Mode, title: string, disabled = false): HTMLButtonElement => {
      const b = this.el("button", "np-btn", ICONS[mode]);
      b.title = title;
      b.disabled = disabled;
      if (disabled) b.appendChild(this.el("span", "np-soon", "soon"));
      if (!disabled) b.addEventListener("click", () => this.setMode(mode));
      this.modeButtons.set(mode, b);
      return b;
    };

    const chatBtn = this.el("button", "np-btn", ICONS.chat);
    chatBtn.title = "Feedback queue — show/hide the docked pane";
    this.badgeEl = this.el("span", "np-badge");
    chatBtn.appendChild(this.badgeEl);
    // The docked pane's own toggle can only HIDE it (it slides off with the pane); the dock button is the
    // always-visible affordance to bring it back, and carries the live queue-count badge.
    chatBtn.addEventListener("click", () => this.setPaneShown(!this.paneShown));

    dock.append(
      mkModeBtn("cursor", "Cursor — passive (Esc)"),
      mkModeBtn("region", "Region — drag to screenshot (⌘/Ctrl+Shift+X freezes hover-only UI)"),
      mkModeBtn("element", "Element — hover to outline, click to record"),
      this.el("div", "np-sep"),
      chatBtn,
    );
    return dock;
  }

  private buildPanel(): HTMLElement {
    const panel = this.el("div", "np-panel");

    const head = this.el("div", "np-panel-head");
    // Hide/show toggle at the TOP-LEFT of the pane. Clicking it collapses the pane (removes the reserved
    // width → the app expands to full width). Reopen from the dock's queue button.
    const toggle = this.el("button", "np-pane-toggle", "⟩");
    toggle.title = "Hide feedback pane";
    toggle.addEventListener("click", () => this.setPaneShown(false));
    head.append(toggle, this.el("span", undefined, "nitpicker feedback"));

    this.listEl = this.el("div", "np-list");

    const foot = this.el("div", "np-panel-foot");
    const ta = this.el("textarea");
    ta.placeholder = "Add a message…";
    const addBtn = this.el("button", "np-ghost", "Add message");
    addBtn.addEventListener("click", () => {
      if (ta.value.trim()) {
        this.addMessage(ta.value.trim());
        ta.value = "";
      }
    });
    this.statusEl = this.el("div", "np-status");
    const sendBtn = this.el("button", "np-primary", "Send to agent");
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

  /** Hotkey fast-path into Region mode: arm the drag AND freeze the viewport — both synchronously, in the
   *  same keypress tick. The freeze is a CHEAP structural DOM clone ({@link buildFrozenClone}, ~one frame),
   *  NOT an html2canvas raster: html2canvas is a single ~1–2s SYNCHRONOUS main-thread block (the cost is
   *  DOM traversal + style computation, not pixel fill) that the old path ran at key-press, freezing the
   *  whole viewport. The clone freezes hover-only UI (chart hover-cards, tooltips that vanish on
   *  mouse-move) into a static visual the user boxes; the expensive raster is deferred to drag-end
   *  ({@link captureFrozen}) and reads this clone, onto the same Queue-commit pipeline the dock path uses. */
  private enterRegionFrozen(): void {
    // A capture card is already open (mid-queue) — ignore the hotkey rather than clobber it.
    if (this.freeze.classList.contains("np-show")) return;
    // Drop any prior frozen clone still on screen (double hotkey press) before building a fresh one.
    this.clearSnapshot();
    this.setMode("region"); // arm immediately so the mode reflects the keypress
    this.measureViewport(); // lay the frozen clone out at the live content width (excludes the scrollbar)
    try {
      // Attaches the frozen clone to the light DOM at ~z just below the overlay; the drag bands/outline
      // (shadow DOM, higher z) render on top of it. Laid out at appWidth so its geometry — and the red-box
      // coordinate space — matches the live app.
      this.frozenSnapshot = buildFrozenClone(this.host, this.appWidth(), this.env);
    } catch (err) {
      console.error("nitpicker: region freeze failed", err);
      this.frozenSnapshot = null;
      this.setStatus(`capture failed: ${(err as Error).message}`);
    }
  }

  // ---- region drag ----
  private onDragStart = (e: MouseEvent): void => {
    if (this.mode !== "region") return;
    e.preventDefault();
    this.measureViewport(); // refresh the content-width cache before the drag geometry uses it
    this.dragStart = { x: e.clientX, y: e.clientY };
    // Dock path: DO NOT rasterize here. The selection box is just an overlay rect drawn on the LIVE page,
    // so dragging is instant with no freeze. The screenshot is rasterized later, at Queue-commit time
    // (so a drag the user cancels never captures anything). The hotkey path is the exception — it froze
    // the viewport into a cheap DOM clone at key-press (frozenSnapshot set) to preserve hover-only UI, and
    // the drag happens over that frozen clone.
    for (const b of this.bands) b.style.display = "block";
    this.outline.style.display = "block";
    this.updateDrag(e.clientX, e.clientY);
    this.env.win.addEventListener("mousemove", this.onDragMove);
    this.env.win.addEventListener("mouseup", this.onDragEnd);
  };

  private onDragMove = (e: MouseEvent): void => {
    if (this.dragStart) this.updateDrag(e.clientX, e.clientY);
  };

  private onDragEnd = (e: MouseEvent): void => {
    this.env.win.removeEventListener("mousemove", this.onDragMove);
    this.env.win.removeEventListener("mouseup", this.onDragEnd);
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
    if (this.frozenSnapshot) {
      // Hotkey path: DEFER the raster of the key-press-time frozen clone (never re-rasterize the live DOM —
      // the hover state is gone) onto the same Queue-commit pipeline the dock path uses.
      this.captureFrozen(rect);
    } else {
      // Dock path: open the queue card INSTANTLY over the live page (no freeze). The screenshot is
      // rasterized only if/when the user commits with Queue (enqueueRegion below), so a canceled drag
      // captures nothing. Leave the dim bands + red outline ON SCREEN as the persistent "selected region"
      // visual (torn down by unfreeze() on Queue/Cancel/Esc) so the user can see what they framed while
      // composing — only the drag *state* (dragStart) is cleared, already nulled above.
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
    const vh = this.env.win.innerHeight;
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
    // Tear down a not-yet-captured frozen clone (the user bailed before drawing). A clone whose raster is
    // already in flight is NOT owned here — it lives on the raster promise (captureFrozenShot removes its
    // holder in `.finally`), because html2canvas is still reading it.
    if (this.frozenSnapshot) {
      this.frozenSnapshot.holder.remove();
      this.frozenSnapshot = null;
    }
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
    return captureRegion(rect, this.scale, this.host, this.appWidth(), this.env)
      .then(({ blob, thumb }) => ({ blob, thumb }))
      .finally(() => {
        this.pendingDockRasters--;
        this.setPaneLocked(this.paneLocked());
        this.maybeReconcileLayout();
      });
  }

  /**
   * Hotkey path, on mouse-up: kick the DEFERRED raster of the key-press-time frozen clone and open the
   * queue card over it — reusing the dock path's Queue-commit machinery (async raster → "capturing…"
   * placeholder → blob attached before send). The frozen clone stays on screen as the backdrop while the
   * raster runs, then {@link captureFrozenShot} tears it down. Mirrors the dock branch of onDragEnd but
   * sources the screenshot from the clone (whose hover-only UI is frozen) instead of the live DOM.
   */
  private captureFrozen(rect: Rect): void {
    const snapshot = this.frozenSnapshot;
    this.frozenSnapshot = null; // leaves the drawing phase; the holder is now the card's backdrop
    if (!snapshot) {
      this.clearDrag();
      return;
    }
    // Hand the holder to the card-backdrop lifecycle: removed on card close (Cancel/Esc) unless its raster
    // is mid-flight, in which case the raster's `.finally` removes it. The frozen page stays visible (with
    // its hover-only UI) behind the card while the user types. Keep the dim bands + red outline on top of
    // the frozen clone as the persistent selection visual (torn down by unfreeze()) — only clear the drag
    // *state*, which onDragEnd already nulled, so the framed region stays visible while composing.
    this.frozenHolder = snapshot.holder;
    this.openCard(
      rect,
      (text) => this.enqueueRegion(rect, this.captureFrozenShot(snapshot, rect), text),
      { backdrop: true },
    );
  }

  /** Hotkey path: rasterize the frozen clone (deferred, off the key-press) and red-box the selection.
   *  Holds the pane reflow-lock for the FULL raster (shared with the dock path via {@link pendingDockRasters})
   *  and removes the frozen holder once html2canvas has consumed it — whether the raster succeeds or fails,
   *  and whether or not the card is still open (html2canvas snapshots the holder synchronously, so removing
   *  it on settle can't corrupt the result). */
  private captureFrozenShot(
    snapshot: FrozenSnapshot,
    rect: Rect,
  ): Promise<{ blob: Blob; thumb: string }> {
    // Take ownership of the holder away from the card-close path up front: from here the raster's `.finally`
    // is its SOLE remover. This decouples cleanup from any unrelated in-flight raster — unfreeze() can then
    // drop a still-set frozenHolder unconditionally (Cancel/Esc) without stranding one mid-raster.
    if (this.frozenHolder === snapshot.holder) this.frozenHolder = null;
    this.pendingDockRasters++;
    return rasterizeFrozen(snapshot, this.scale)
      .then(({ canvas }) => annotateRegion(canvas, rect, this.scale, snapshot.viewport.w, this.env))
      .finally(() => {
        snapshot.holder.remove();
        this.pendingDockRasters--;
        this.setPaneLocked(this.paneLocked());
        this.maybeReconcileLayout();
      });
  }

  /**
   * The shared "queue a message" card (one card, reused by both region and element). Anchored under
   * `anchor`, clamped into the viewport, hosted on the freeze layer. Both region and element callers pass
   * `{ backdrop: true }`, so the card gets the same transparent click-catching `np-backdrop` — app clicks
   * behind the card don't leak while it's open (the region path's frozen visual is now the light-DOM clone,
   * not a promoted opaque canvas).
   */
  private openCard(
    anchor: Rect,
    onQueue: (text: string) => void,
    opts?: { backdrop?: boolean },
  ): void {
    const done = (): void => this.unfreeze();

    if (opts?.backdrop) {
      const back = this.el("div", "np-backdrop");
      back.addEventListener("click", done);
      this.freeze.appendChild(back);
    }

    const card = this.el("div", "np-card");
    const ta = this.el("textarea");
    ta.placeholder = "What should change here?";
    const actions = this.el("div", "np-actions");
    const cancel = this.el("button", "np-ghost", "Cancel");
    const queue = this.el("button", "np-primary", "Queue");
    actions.append(cancel, queue);
    card.append(ta, actions);

    // clamp near the anchor, inside the app area (so the card never lands under the docked pane)
    const left = Math.min(anchor.x, this.appWidth() - 296);
    const top = Math.min(anchor.y + anchor.h + 8, this.env.win.innerHeight - 160);
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
    this.env.doc.addEventListener("mouseover", this.onElementOver, true);
    this.env.doc.addEventListener("mouseout", this.onElementOut, true);
    this.env.doc.addEventListener("click", this.onElementClick, true);
    this.prevBodyCursor = this.env.doc.body.style.cursor;
    this.env.doc.body.style.cursor = "crosshair";
  }

  private disableElementPicker(): void {
    if (!this.pickerOn) return;
    this.pickerOn = false;
    this.env.doc.removeEventListener("mouseover", this.onElementOver, true);
    this.env.doc.removeEventListener("mouseout", this.onElementOut, true);
    this.env.doc.removeEventListener("click", this.onElementClick, true);
    if (this.prevBodyCursor !== null) {
      this.env.doc.body.style.cursor = this.prevBodyCursor;
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
    // Tear down the persistent region selection visual (dim bands + red outline) that onDragEnd/captureFrozen
    // now leave on screen while the card is open. This is the single teardown point for Queue (via done()),
    // Cancel, backdrop-click, and Esc — so the framed region always clears exactly when the card closes.
    // A no-op for the element card / view-edit modal (no drag active), which also route through unfreeze().
    this.clearDrag();
    // Keep the visual dimming while a dock raster is still in flight — the functional lock (paneLocked)
    // outlives the card, so the pane must LOOK locked or its toggle silently no-ops.
    this.setPaneLocked(this.pendingDockRasters > 0);
    this.clearSnapshot();
    // Drop the hotkey freeze backdrop when its card closes. If its own raster is in flight, captureFrozenShot
    // already transferred ownership (nulled frozenHolder) and its `.finally` is the sole remover; so a set
    // frozenHolder here always means Cancel/Esc with no raster reading it — remove it unconditionally,
    // regardless of any unrelated dock raster still counted in pendingDockRasters.
    if (this.frozenHolder) {
      this.frozenHolder.remove();
      this.frozenHolder = null;
    }
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
    const back = this.el("div", "np-backdrop");
    back.addEventListener("click", () => this.unfreeze());
    this.freeze.appendChild(back);

    const modal = this.el("div", "np-modal");
    const head = this.el("div", "np-modal-head");
    const title =
      item.kind === "region" ? "Region mark" : item.kind === "element" ? "Element mark" : "Message";
    const close = this.el("button", "np-x", "✕");
    close.addEventListener("click", () => this.unfreeze());
    head.append(this.el("span", undefined, title), close);
    modal.appendChild(head);

    const bodyWrap = this.el("div", "np-modal-body");
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
      bodyWrap.appendChild(this.el("div", "np-modal-desc", lines.join("\n") || "(element)"));
    }
    modal.appendChild(bodyWrap);

    const ta = this.el("textarea");
    ta.placeholder = "Message…";
    ta.value = item.text ?? "";
    modal.appendChild(ta);

    const actions = this.el("div", "np-actions");
    const remove = this.el("button", "np-ghost", "Remove");
    remove.addEventListener("click", () => {
      this.removeItem(item.id);
      this.unfreeze();
    });
    const save = this.el("button", "np-primary", "Save");
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
      const img = this.el("img", "np-modal-img");
      img.src = src;
      if (url) this.modalCleanup = () => URL.revokeObjectURL(url);
      wrap.appendChild(img);
    } else {
      wrap.appendChild(
        this.el("div", "np-modal-note", item._error ? "Screenshot capture failed." : "Capturing screenshot…"),
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
      pageUrl: this.env.win.location.href,
      route: this.env.win.location.pathname,
      viewport: this.viewport(),
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
      pageUrl: this.env.win.location.href,
      route: this.env.win.location.pathname,
      viewport: this.viewport(),
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
      pageUrl: this.env.win.location.href,
      route: this.env.win.location.pathname,
      viewport: this.viewport(),
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
        this.el(
          "div",
          "np-empty",
          "No feedback queued yet.\nUse Region to screenshot, Element to pick a component, or add a message below.",
        ),
      );
      return;
    }
    for (const item of this.queue) {
      const row = this.el("div", "np-item");
      if (item.kind === "region") {
        if (item._thumb) {
          const img = this.el("img");
          img.src = item._thumb;
          row.appendChild(img);
        } else {
          // raster still in flight (dock path rasterizes at Queue), or it failed
          row.appendChild(this.el("div", "np-item-thumb-ph", item._error ? "✕" : "…"));
        }
      }
      const body = this.el("div", "np-item-body");
      body.appendChild(this.el("div", "np-item-kind", item.kind));
      const textEl = this.el("div", "np-item-text");
      textEl.textContent = item.text || "(no note)";
      body.appendChild(textEl);
      if (item.kind === "region" && !item._thumb) {
        body.appendChild(
          this.el("div", "np-item-chip", item._error ? `capture failed` : "capturing…"),
        );
      }
      if (item.kind === "element" && item.element) {
        const chip = item.element.component ?? item.element.selector ?? "";
        if (chip) {
          const chipEl = this.el("div", "np-item-chip");
          chipEl.textContent = chip;
          body.appendChild(chipEl);
        }
      }
      const x = this.el("button", "np-x", "✕");
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
    return this.paneShown && this.env.win.innerWidth > PANE_MIN_VIEWPORT ? PANE_W : 0;
  }

  /** The app's rendered area width — the viewport content box (minus any classic scrollbar) minus the
   *  pane's reserved gutter. Region capture and the drag selection are both confined to this so a
   *  screenshot never includes the pane, and the frozen clone lays out at exactly the live content width
   *  (no shift on freeze — Issue 1). Reads the cached {@link viewportContentW}, falling back to innerWidth. */
  private appWidth(): number {
    return (this.viewportContentW || this.env.win.innerWidth) - this.reservedWidth();
  }

  /** Refresh the cached viewport content width from documentElement.clientWidth (viewport MINUS a classic
   *  scrollbar's gutter; unaffected by the pane's <html> margin-right, which is a special case for the root
   *  element). Called only when the geometry can change — mount, resize, drag/freeze entry — so appWidth()
   *  and the hot per-frame drag path never force a synchronous layout. clientWidth is 0 in a non-layout env
   *  (jsdom) → fall back to innerWidth, keeping behavior identical there (and under 0-width overlay scrollbars). */
  private measureViewport(): void {
    const client = this.env.doc.documentElement.clientWidth;
    this.viewportContentW = client > 0 ? client : this.env.win.innerWidth;
  }

  private setPaneShown(shown: boolean): void {
    // A capture card/modal is open OR a dock raster is still in flight: toggling the pane now would reflow
    // the app (change appWidth) while a screenshot is pending, desyncing the red box from what was
    // selected. The lock spans the FULL raster, not just the card's lifetime (see paneLocked). Ignore it.
    if (this.paneLocked()) return;
    this.paneShown = shown;
    try {
      this.env.win.localStorage.setItem(PANE_STORAGE_KEY, shown ? "1" : "0");
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
    this.env.doc.documentElement.style.marginRight = reserve
      ? `${reserve}px`
      : this.prevHtmlMarginRight;
    // keep the region drag layer (and its dim bands) out of the pane's gutter
    this.interaction.style.right = `${reserve}px`;
  }

  private onResize = (): void => {
    // Don't reflow the app while a card/modal is open or a dock raster is in flight — an appWidth change
    // would desync the pending screenshot. maybeReconcileLayout() catches up once the lock releases.
    if (this.paneLocked()) return;
    this.measureViewport(); // viewport (and thus its scrollbar gutter) may have changed
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
    this.env.doc.removeEventListener("keydown", this.onKeydown, true);
    this.env.win.removeEventListener("mousemove", this.onDragMove);
    this.env.win.removeEventListener("mouseup", this.onDragEnd);
    this.env.win.removeEventListener("resize", this.onResize);
    // tear down any open card/modal so its object URL (item screenshot) is revoked, not leaked
    this.unfreeze();
    // remove any frozen-clone holder left in the light DOM — the not-yet-captured one (via unfreeze →
    // clearSnapshot) plus any whose deferred raster is still in flight (belt-and-braces so none survive
    // teardown; its raster's `.finally` .remove() is then a no-op).
    this.env.doc.querySelectorAll('[data-nitpicker="frozen"]').forEach((n) => n.remove());
    // release the reserved gutter — restore the host <html> inline styles exactly as we found them
    this.env.doc.documentElement.style.marginRight = this.prevHtmlMarginRight;
    this.env.doc.documentElement.style.transition = this.prevHtmlTransition;
    this.disableElementPicker();
    this.host.remove();
  }
}
