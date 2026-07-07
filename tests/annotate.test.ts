// The per-mark annotate popup for the embedded builder pane (restores the classic confirm/annotate step the
// extracted InteractionLayer dropped). Verifies the confirm-attaches / cancel-discards contract that
// BuilderChrome.onMark relies on, plus single-instance behavior. Runs under the default jsdom env.
import { describe, it, expect, beforeEach } from "vitest";
import { AnnotationPopup, annotateLabel } from "../src/builder/annotate";
import type { ParentBox } from "../src/shell/geometry";

const ANCHOR: ParentBox = { left: 40, top: 60, width: 120, height: 30 };

function popEl(): HTMLElement | null {
  return document.querySelector(".nh-annotate");
}
function input(): HTMLInputElement {
  return document.querySelector(".nh-annotate-input") as HTMLInputElement;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("AnnotationPopup", () => {
  it("opens a popup with a note input + Queue/Cancel buttons near the anchor", () => {
    const pop = new AnnotationPopup();
    pop.open(ANCHOR, { onConfirm: () => {}, onCancel: () => {} }, { label: "hi" });
    expect(pop.isOpen).toBe(true);
    const el = popEl();
    expect(el).not.toBeNull();
    expect(el!.style.position).toBe("fixed");
    expect(input()).not.toBeNull();
    expect(document.querySelector(".nh-annotate-queue")).not.toBeNull();
    expect(document.querySelector(".nh-annotate-cancel")).not.toBeNull();
    expect(el!.textContent).toContain("hi");
  });

  it("Queue confirms with the typed note and removes the popup", () => {
    const pop = new AnnotationPopup();
    let note: string | null = null;
    let cancelled = false;
    pop.open(ANCHOR, { onConfirm: (n) => (note = n), onCancel: () => (cancelled = true) });
    input().value = "make it blue";
    (document.querySelector(".nh-annotate-queue") as HTMLButtonElement).click();
    expect(note).toBe("make it blue");
    expect(cancelled).toBe(false);
    expect(pop.isOpen).toBe(false);
    expect(popEl()).toBeNull();
  });

  it("confirms with an empty note when nothing is typed (note is optional)", () => {
    const pop = new AnnotationPopup();
    let note: string | null = null;
    pop.open(ANCHOR, { onConfirm: (n) => (note = n), onCancel: () => {} });
    (document.querySelector(".nh-annotate-queue") as HTMLButtonElement).click();
    expect(note).toBe("");
  });

  it("Cancel discards (onCancel, not onConfirm) and removes the popup", () => {
    const pop = new AnnotationPopup();
    let confirmed = false;
    let cancelled = false;
    pop.open(ANCHOR, { onConfirm: () => (confirmed = true), onCancel: () => (cancelled = true) });
    (document.querySelector(".nh-annotate-cancel") as HTMLButtonElement).click();
    expect(cancelled).toBe(true);
    expect(confirmed).toBe(false);
    expect(popEl()).toBeNull();
  });

  it("Escape in the input cancels (discards)", () => {
    const pop = new AnnotationPopup();
    let cancelled = false;
    pop.open(ANCHOR, { onConfirm: () => {}, onCancel: () => (cancelled = true) });
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(cancelled).toBe(true);
    expect(popEl()).toBeNull();
  });

  it("Enter in the input confirms", () => {
    const pop = new AnnotationPopup();
    let note: string | null = null;
    pop.open(ANCHOR, { onConfirm: (n) => (note = n), onCancel: () => {} });
    input().value = "shrink the gap";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(note).toBe("shrink the gap");
  });

  it("resolves exactly once — a second click is a no-op", () => {
    const pop = new AnnotationPopup();
    let confirms = 0;
    pop.open(ANCHOR, { onConfirm: () => confirms++, onCancel: () => {} });
    const queue = document.querySelector(".nh-annotate-queue") as HTMLButtonElement;
    queue.click();
    queue.click(); // the button is detached, but guard against a stale ref too
    expect(confirms).toBe(1);
  });

  it("opening a second popup cancels the first (single instance)", () => {
    const pop = new AnnotationPopup();
    let firstCancelled = false;
    pop.open(ANCHOR, { onConfirm: () => {}, onCancel: () => (firstCancelled = true) });
    pop.open(ANCHOR, { onConfirm: () => {}, onCancel: () => {} });
    expect(firstCancelled).toBe(true);
    // exactly one popup in the DOM
    expect(document.querySelectorAll(".nh-annotate").length).toBe(1);
  });

  it("centers (no throw) when opened without an anchor", () => {
    const pop = new AnnotationPopup();
    pop.open(undefined, { onConfirm: () => {}, onCancel: () => {} });
    const el = popEl()!;
    expect(el.style.left).not.toBe("");
    expect(el.style.top).not.toBe("");
  });
});

describe("annotateLabel", () => {
  it("gives a per-kind prompt", () => {
    expect(annotateLabel("region")).toMatch(/region/i);
    expect(annotateLabel("element")).toMatch(/element/i);
    expect(annotateLabel("text-edit")).toMatch(/text edit/i);
    expect(annotateLabel("message")).toMatch(/agent/i);
  });
});
