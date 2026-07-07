// InteractionLayer — the shared parent-window interaction machinery extracted from ShellChrome (hz-agent
// §7). This guards the EXTRACTION: the mode toolbar + state machine + overlay DOM behave the same for both
// the shell (sidecar sink) and the builder pane (gateway sink). The §5 geometry + Env reads themselves stay
// covered by tests/shell-geometry.test.ts + vendor env-seam.test.ts. Runs under the default jsdom env.
import { describe, it, expect, beforeEach } from "vitest";
import { InteractionLayer, type InteractionSink } from "../src/shell/interaction";

function scaffold(): void {
  document.body.innerHTML = `
    <div id="nh-stage"><iframe id="nh-frame" src="about:blank"></iframe></div>
    <button id="nh-mode-cursor" class="nh-mode nh-active" data-mode="cursor"></button>
    <button id="nh-mode-region" class="nh-mode" data-mode="region"></button>
    <button id="nh-mode-element" class="nh-mode" data-mode="element"></button>
    <button id="nh-mode-edit" class="nh-mode" data-mode="edit"></button>
  `;
}

function makeSink(): InteractionSink & { marks: unknown[]; status: string } {
  const marks: unknown[] = [];
  return {
    marks,
    status: "",
    takeNote: () => "",
    onMark(item) {
      marks.push(item);
    },
    removeMark() {},
    setStatus(msg) {
      (this as { status: string }).status = msg;
    },
    onCaptureSettled() {},
  };
}

function activeMode(): string | undefined {
  return [...document.querySelectorAll(".nh-mode")].find((b) => b.classList.contains("nh-active"))?.id;
}

describe("InteractionLayer extraction", () => {
  beforeEach(() => scaffold());

  it("builds the parent-hosted overlay layer on construction", () => {
    new InteractionLayer(makeSink());
    const overlay = document.getElementById("nh-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.style.position).toBe("fixed");
    // The drag surface + highlight box live inside it.
    expect(overlay!.children.length).toBeGreaterThanOrEqual(2);
  });

  it("wires the mode toolbar: clicking a mode button makes it the active one", () => {
    new InteractionLayer(makeSink());
    expect(activeMode()).toBe("nh-mode-cursor");

    (document.getElementById("nh-mode-region") as HTMLButtonElement).click();
    expect(activeMode()).toBe("nh-mode-region");

    (document.getElementById("nh-mode-element") as HTMLButtonElement).click();
    expect(activeMode()).toBe("nh-mode-element");
  });

  it("toggles the region drag surface with the region mode", () => {
    new InteractionLayer(makeSink());
    const drag = document.getElementById("nh-overlay")!.firstElementChild as HTMLElement;
    expect(drag.style.display).toBe("none");
    (document.getElementById("nh-mode-region") as HTMLButtonElement).click();
    expect(drag.style.display).toBe("block");
    expect(drag.style.pointerEvents).toBe("auto");
  });

  it("Escape returns to passive cursor mode from any mode", () => {
    new InteractionLayer(makeSink());
    (document.getElementById("nh-mode-element") as HTMLButtonElement).click();
    expect(activeMode()).toBe("nh-mode-element");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(activeMode()).toBe("nh-mode-cursor");
  });

  it("exposes setMode as the public entry the host can drive", () => {
    const layer = new InteractionLayer(makeSink());
    layer.setMode("region");
    expect(activeMode()).toBe("nh-mode-region");
  });

  it("showSelection renders the persistent red box + dim, clearSelection hides it", () => {
    const layer = new InteractionLayer(makeSink());
    const sel = document.getElementById("nh-selection") as HTMLElement;
    expect(sel).not.toBeNull();
    expect(sel.style.display).toBe("none"); // hidden until a mark shows it
    layer.showSelection({ left: 10, top: 20, width: 100, height: 40 });
    expect(sel.style.display).toBe("block");
    // the inner box carries a huge box-shadow spread — the "dim backdrop with a hole"
    const box = sel.firstElementChild as HTMLElement;
    expect(box.style.boxShadow).toContain("9999px");
    layer.clearSelection();
    expect(sel.style.display).toBe("none");
  });

  it("showSelection without an anchor is a no-op (never throws)", () => {
    const layer = new InteractionLayer(makeSink());
    layer.showSelection(undefined);
    expect((document.getElementById("nh-selection") as HTMLElement).style.display).toBe("none");
  });
});
