// nitpicker — the framework-agnostic element descriptor + selector fallback chain. The picker's whole
// promise is "agent-grade even with no React info", so these pin the fallback order: stable id → test
// hook → stable class → :nth-of-type, plus the descriptor assembly. Runs DOM-less (vitest node env)
// against minimal fake elements.
import { describe, it, expect } from "vitest";
import {
  cssSelector,
  baseDescriptor,
  nearestTestid,
  visibleText,
  isStableId,
  stableClass,
} from "../core/elements";

type Rectish = { x: number; y: number; width: number; height: number };

/** Minimal fake DOM node exposing exactly the surface elements.ts touches. */
function elx(
  tag: string,
  opts: { id?: string; attrs?: Record<string, string>; text?: string; rect?: Rectish } = {},
  children: FakeEl[] = [],
): FakeEl {
  const attrs = { ...(opts.attrs ?? {}) };
  const node: FakeEl = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    id: opts.id ?? "",
    parentElement: null,
    children,
    innerText: opts.text,
    textContent: opts.text,
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    getBoundingClientRect: () => opts.rect ?? { x: 0, y: 0, width: 0, height: 0 },
  };
  for (const c of children) c.parentElement = node;
  return node;
}

interface FakeEl {
  tagName: string;
  nodeType: 1;
  id: string;
  parentElement: FakeEl | null;
  children: FakeEl[];
  innerText?: string;
  textContent?: string;
  getAttribute(n: string): string | null;
  getBoundingClientRect(): Rectish;
}

const asEl = (e: FakeEl): Element => e as unknown as Element;

describe("isStableId", () => {
  it("accepts author-written ids", () => {
    expect(isStableId("members-panel")).toBe(true);
    expect(isStableId("app")).toBe(true);
  });
  it("rejects framework-generated / volatile ids", () => {
    expect(isStableId(":r3:")).toBe(false); // React useId
    expect(isStableId("radix-:r0:")).toBe(false);
    expect(isStableId("123abc")).toBe(false); // hash/number-leading
    expect(isStableId("")).toBe(false);
  });
});

describe("stableClass", () => {
  it("returns a plain, unique author class", () => {
    const nav = elx("nav", {}, [elx("a", { attrs: { class: "brand" } }), elx("a", {})]);
    expect(stableClass(asEl(nav.children[0]))).toBe("brand");
  });
  it("skips utilities, hashes, and sizing classes", () => {
    expect(
      stableClass(asEl(elx("div", { attrs: { class: "hover:bg-red sm:px-2" } }))),
    ).toBeUndefined();
    expect(stableClass(asEl(elx("div", { attrs: { class: "px-2 mt-4" } })))).toBeUndefined();
    expect(
      stableClass(asEl(elx("div", { attrs: { class: "styles_row__x7Yq3" } }))),
    ).toBeUndefined();
  });
  it("skips a class shared by same-tag siblings (ambiguous)", () => {
    const ul = elx("ul", {}, [
      elx("li", { attrs: { class: "row" } }),
      elx("li", { attrs: { class: "row" } }),
    ]);
    expect(stableClass(asEl(ul.children[0]))).toBeUndefined();
  });
});

describe("cssSelector", () => {
  it("anchors on a stable id and stops climbing", () => {
    const section = elx("section", { id: "members-panel" }, [elx("table", {})]);
    expect(cssSelector(asEl(section))).toBe("#members-panel");
  });

  it("ignores a volatile id and uses the positional path", () => {
    const div = elx("div", { id: ":r3:" });
    expect(cssSelector(asEl(div))).toBe("div");
  });

  it("prefers a test hook and truncates the path to it", () => {
    const tr = elx("tr", { attrs: { "data-testid": "member-row" } });
    const tbody = elx("tbody", {}, [tr]);
    elx("table", {}, [tbody]); // give it ancestors it should NOT include
    expect(cssSelector(asEl(tr))).toBe('tr[data-testid="member-row"]');
  });

  it("supports the data-test alias", () => {
    const btn = elx("button", { attrs: { "data-test": "pay-now" } });
    expect(cssSelector(asEl(btn))).toBe('button[data-test="pay-now"]');
  });

  it("falls back to :nth-of-type among same-tag siblings", () => {
    const rows = [elx("tr", {}), elx("tr", {}), elx("tr", {})];
    const tbody = elx("tbody", {}, rows);
    const table = elx("table", {}, [tbody]);
    void table;
    const sel = cssSelector(asEl(rows[2]));
    expect(sel.endsWith("tr:nth-of-type(3)")).toBe(true);
    expect(sel).toBe("table > tbody > tr:nth-of-type(3)");
  });

  it("uses a stable class in the path when present", () => {
    const a = elx("a", { attrs: { class: "brand" } });
    const nav = elx("nav", {}, [a, elx("a", {})]);
    void nav;
    expect(cssSelector(asEl(a))).toBe("nav > a.brand");
  });

  it("caps the path depth at 5 levels", () => {
    let node = elx("span", {});
    for (let i = 0; i < 10; i++) node = elx("div", {}, [node]);
    const parts = cssSelector(asEl(deepest(node))).split(" > ");
    expect(parts.length).toBeLessThanOrEqual(5);
  });
});

describe("nearestTestid", () => {
  it("walks up to an ancestor's test hook", () => {
    const cell = elx("td", {});
    elx("tr", { attrs: { "data-testid": "member-row" } }, [cell]);
    expect(nearestTestid(asEl(cell))).toBe("member-row");
  });
});

describe("visibleText", () => {
  it("trims + caps innerText at 240 chars", () => {
    const long = "x".repeat(400);
    expect(visibleText(asEl(elx("div", { text: `  ${long}  ` })))!.length).toBe(240);
  });
  it("falls back to aria-label when there's no text", () => {
    const btn = elx("button", { attrs: { "aria-label": "Close dialog" } });
    expect(visibleText(asEl(btn))).toBe("Close dialog");
  });
});

describe("baseDescriptor", () => {
  it("assembles the full agent-grade descriptor with no React info", () => {
    const tr = elx("tr", {
      attrs: { "data-testid": "member-row", role: "row" },
      text: "Ada Lovelace — Gold — active",
      rect: { x: 24.4, y: 310.6, width: 900.2, height: 44.9 },
    });
    const d = baseDescriptor(asEl(tr));
    expect(d).toMatchObject({
      testid: "member-row",
      selector: 'tr[data-testid="member-row"]',
      tag: "tr",
      role: "row",
      text: "Ada Lovelace — Gold — active",
      rect: { x: 24, y: 311, w: 900, h: 45 },
    });
    // no React fields — those come from the host resolveElement seam
    expect(d.component).toBeUndefined();
    expect(d.source).toBeUndefined();
  });
});

/** Descend to the innermost (childless) node of a single-child chain. */
function deepest(node: FakeEl): FakeEl {
  let n = node;
  while (n.children.length) n = n.children[0];
  return n;
}
