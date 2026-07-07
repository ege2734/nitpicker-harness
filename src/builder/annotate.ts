// nitpicker-harness — the per-mark ANNOTATE popup for the embedded builder pane. Restores the classic
// feedback-overlay flow (vendor/nitpicker/core/overlay.ts `openCard`) that the extracted InteractionLayer
// dropped: a just-created mark (region / element / inline-edit) no longer auto-attaches silently — instead a
// small popup opens near the selection with a note input + Queue / Cancel. Confirm attaches the mark PLUS the
// typed note as a chip; Cancel (button or Esc) DISCARDS it. Builder-pane only — the classic shell keeps its
// silent auto-queue (ShellChrome.onMark just pushes).
//
// Self-contained (inline styles matching the dark builder chrome), so it needs no server-rendered markup and
// stays unit-testable in jsdom (tests/annotate.test.ts). Runs in the PARENT window, positioned in parent-
// viewport coords via the `anchor` the InteractionLayer hands to `onMark`.
import type { ParentBox } from "../shell/geometry";

export interface AnnotationHandlers {
  /** Confirm — the note (may be empty) the user typed; the host attaches the mark + this note. */
  onConfirm: (note: string) => void;
  /** Cancel — the host discards the mark (never queued). */
  onCancel: () => void;
}

export interface AnnotationOptions {
  /** Prompt shown above the input (defaults to a generic ask). */
  label?: string;
}

/** A single-instance parent-window popup: open() near an anchor, resolve exactly once via confirm/cancel. */
export class AnnotationPopup {
  private el: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private handlers: AnnotationHandlers | null = null;
  private settled = false;

  /** Is a popup currently open (unresolved)? */
  get isOpen(): boolean {
    return this.el !== null;
  }

  /** Open near `anchor` (parent-viewport rect; omitted → centered near the top of the window). Any previously
   *  open popup is resolved as a cancel first, so at most one is ever live. */
  open(anchor: ParentBox | undefined, handlers: AnnotationHandlers, opts?: AnnotationOptions): void {
    this.cancel(); // resolve a prior popup (if any) as a discard before opening a new one
    this.handlers = handlers;
    this.settled = false;

    const pop = document.createElement("div");
    pop.className = "nh-annotate";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Annotate mark");
    pop.style.cssText =
      "position:fixed;z-index:2147483001;width:280px;max-width:calc(100vw - 16px);box-sizing:border-box;" +
      "display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid #2b313a;border-radius:10px;" +
      "background:#14171b;color:#e6e8eb;box-shadow:0 8px 28px rgba(0,0,0,.5);" +
      "font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

    const label = document.createElement("div");
    label.textContent = opts?.label ?? "What should the agent do with this?";
    label.style.cssText = "font-size:11px;color:#9aa2ac;";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "nh-annotate-input";
    input.placeholder = "Describe the change… (optional)";
    input.style.cssText =
      "width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid #2b313a;" +
      "background:#0e1114;color:#e6e8eb;font:inherit;";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.confirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.cancel();
      }
    });

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;";
    const queueBtn = document.createElement("button");
    queueBtn.type = "button";
    queueBtn.className = "nh-annotate-queue";
    queueBtn.textContent = "Queue";
    queueBtn.style.cssText =
      "flex:1 1 auto;padding:7px 10px;border-radius:8px;border:1px solid #2b5cff;background:#2b5cff;" +
      "color:#fff;font:inherit;font-weight:600;cursor:pointer;";
    queueBtn.addEventListener("click", () => this.confirm());
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "nh-annotate-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText =
      "flex:0 0 auto;padding:7px 10px;border-radius:8px;border:1px solid #2b313a;background:#1f242c;" +
      "color:#e6e8eb;font:inherit;cursor:pointer;";
    cancelBtn.addEventListener("click", () => this.cancel());
    row.append(queueBtn, cancelBtn);

    pop.append(label, input, row);
    document.body.appendChild(pop);
    this.el = pop;
    this.input = input;
    this.position(anchor);
    input.focus();
  }

  /** Resolve as confirm with the current note. No-op if nothing is open / already resolved. */
  confirm(): void {
    if (!this.el || this.settled) return;
    this.settled = true;
    const note = this.input?.value.trim() ?? "";
    const h = this.handlers;
    this.teardown();
    h?.onConfirm(note);
  }

  /** Resolve as cancel (discard). No-op if nothing is open / already resolved. */
  cancel(): void {
    if (!this.el || this.settled) return;
    this.settled = true;
    const h = this.handlers;
    this.teardown();
    h?.onCancel();
  }

  private teardown(): void {
    this.el?.remove();
    this.el = null;
    this.input = null;
    this.handlers = null;
  }

  /** Place the popup below the selection (flipping above if it would overflow), clamped to the viewport. */
  private position(anchor?: ParentBox): void {
    const pop = this.el;
    if (!pop) return;
    const pw = pop.offsetWidth || 280;
    const ph = pop.offsetHeight || 108;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    let left: number;
    let top: number;
    if (anchor) {
      left = anchor.left;
      top = anchor.top + anchor.height + 8;
      if (top + ph > vh - 8) top = anchor.top - ph - 8; // flip above when it would spill off the bottom
    } else {
      left = (vw - pw) / 2;
      top = 24;
    }
    left = Math.max(8, Math.min(left, vw - pw - 8));
    top = Math.max(8, Math.min(top, vh - ph - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
}

/** The per-kind prompt shown at the top of the annotate popup. */
export function annotateLabel(kind: string): string {
  switch (kind) {
    case "region":
      return "Region selected — what should the agent do here?";
    case "element":
      return "Element picked — what should the agent do with it?";
    case "text-edit":
      return "Text edit — add a note for the agent (optional).";
    default:
      return "What should the agent do with this?";
  }
}
