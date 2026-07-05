// nitpicker — the React/Next `resolveElement` glue. Pins the two React-specific fields the picker relies
// on: component name from a fiber walk, and source file:line from the dev-only `data-nitpicker-source`
// stamp (read off the node or nearest ancestor). DOM-less: fake nodes carry a `__reactFiber$…` key and
// a minimal getAttribute/parentElement surface, matching real React DOM.
import { describe, it, expect } from "vitest";
import { resolveReactElement } from "../react/react-source";

interface Fiber {
  type?: unknown;
  name?: string;
  return?: Fiber | null;
  _debugOwner?: Fiber | null;
}

function node(
  fiber: Fiber | null,
  attrs: Record<string, string> = {},
  parent: Element | null = null,
): Element {
  const n: Record<string, unknown> = {
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    parentElement: parent,
  };
  if (fiber) n["__reactFiber$abc123"] = fiber; // the well-known key React attaches to DOM nodes
  return n as unknown as Element;
}

describe("resolveReactElement", () => {
  it("recovers component name (via _debugOwner) + source file:line (from the stamp)", () => {
    const owner: Fiber = { type: function MemberRow() {} };
    const host: Fiber = { type: "tr", _debugOwner: owner };
    const n = node(host, { "data-nitpicker-source": "src/components/member-row.tsx:42:7" });
    expect(resolveReactElement(n)).toEqual({
      component: "MemberRow",
      source: "src/components/member-row.tsx:42:7",
    });
  });

  it("recovers the name from a React 19 owner-info `_debugOwner` (name on `.name`, no `.type`)", () => {
    // React 19 replaced the fiber `_debugOwner` with a ReactComponentInfo carrying `.name` directly.
    const owner: Fiber = { name: "FeedbackCard" };
    const host: Fiber = { type: "button", _debugOwner: owner };
    expect(resolveReactElement(node(host)).component).toBe("FeedbackCard");
  });

  it("climbs the `return` chain and unwraps a forwardRef component", () => {
    const owner: Fiber = { type: { render: function Row() {} } }; // forwardRef wrapper shape
    const host: Fiber = { type: "div", return: owner };
    expect(resolveReactElement(node(host)).component).toBe("Row");
  });

  it("prefers displayName and skips context Provider noise", () => {
    const real: Fiber = { type: function MemberList() {} };
    const provider: Fiber = { type: { displayName: "ThemeContext.Provider" }, _debugOwner: real };
    const host: Fiber = { type: "ul", _debugOwner: provider };
    expect(resolveReactElement(node(host)).component).toBe("MemberList");
  });

  it("reads the source stamp off the nearest ancestor when the node lacks it", () => {
    const ancestor = node(null, { "data-nitpicker-source": "src/app/page.tsx:10:3" });
    const n = node({ type: "span" }, {}, ancestor);
    expect(resolveReactElement(n).source).toBe("src/app/page.tsx:10:3");
  });

  it("returns an empty object (never throws) when there is no fiber or stamp", () => {
    expect(resolveReactElement(node(null))).toEqual({});
  });
});
