// @nitpicker/react — the React/Next host glue for the element picker's `resolveElement` seam.
// `@nitpicker/core` stays framework-agnostic and supplies selector/testid/text; this module enriches a
// picked node with the two React-specific fields:
//
//   • component — the nearest React component name, read from the fiber at RUNTIME (reliable in dev).
//   • source    — "file:line:col", read from the `data-nitpicker-source` attribute a dev-only build
//                 transform stamps onto host JSX (see the `next/` loader wired in next.config).
//                 `_debugSource` was removed in React 19, so a runtime click cannot recover file:line
//                 without this stamp.
//
// This file reads well-known React internals off DOM nodes; it imports no React and never runs in prod
// (mounted only by the dev-only <NitpickerOverlay/> path). Every lookup is best-effort and wrapped so fiber
// archaeology can never break the picker.
import type { ElementDescriptor } from "../core";

/** The attribute the dev-only JSX transform writes: "src/components/foo.tsx:42:7". */
const SOURCE_ATTR = "data-nitpicker-source";

/** Minimal shape of the bits of a React fiber node we read. In React 19, `_debugOwner` is no longer a
 *  fiber but a lightweight `ReactComponentInfo` that carries the owner's name directly on `.name` (its
 *  `.type` is undefined) — so we read `name` too, not just `type`. */
interface Fiberish {
  type?: unknown;
  /** React 19 owner-info: the component name, present on `_debugOwner` nodes (no `.type`). */
  name?: unknown;
  return?: Fiberish | null;
  _debugOwner?: Fiberish | null;
}

/** Find a node's fiber via the well-known `__reactFiber$<hash>` key React attaches to DOM nodes. */
function fiberOf(node: Element): Fiberish | null {
  for (const key in node) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
      return (node as unknown as Record<string, Fiberish>)[key] ?? null;
    }
  }
  return null;
}

/** Resolve a display name from a fiber `type`, unwrapping forwardRef/memo wrappers. Host components
 *  (string types like "div") return undefined so the climb continues to a real component. */
function displayNameOf(type: unknown, depth = 0): string | undefined {
  if (!type || depth > 4) return undefined;
  if (typeof type === "string") return undefined; // host element
  if (typeof type === "function") {
    const fn = type as { displayName?: string; name?: string };
    return fn.displayName || fn.name || undefined;
  }
  if (typeof type === "object") {
    const o = type as { displayName?: string; render?: unknown; type?: unknown };
    return o.displayName || displayNameOf(o.render, depth + 1) || displayNameOf(o.type, depth + 1);
  }
  return undefined;
}

/** Names that are noise rather than a useful component the agent would grep for. */
function isUsefulName(name: string): boolean {
  if (name.length < 2) return false;
  if (/^(Fragment|Suspense|StrictMode|Provider|Consumer|_c|Object)$/.test(name)) return false;
  if (/\.(Provider|Consumer)$/.test(name)) return false; // e.g. "ThemeContext.Provider"
  return true;
}

/** The component name off a React 19 `ReactComponentInfo` owner node (`_debugOwner.name`). Pre-19
 *  fibers have no string `name`, so this returns undefined for them and the `type` path is used. */
function ownerInfoName(fiber: Fiberish): string | undefined {
  return typeof fiber.name === "string" ? fiber.name : undefined;
}

/** Climb `_debugOwner` (the JSX owner — whose source contains this element) then `return` to the
 *  nearest named function/class component. Handles both the pre-19 fiber shape (name on `.type`) and
 *  the React 19 owner-info shape (name on `.name`). */
function componentName(node: Element): string | undefined {
  let fiber = fiberOf(node);
  let hops = 0;
  while (fiber && hops < 100) {
    const name = displayNameOf(fiber.type) ?? ownerInfoName(fiber);
    if (name && isUsefulName(name)) return name;
    fiber = fiber._debugOwner ?? fiber.return ?? null;
    hops++;
  }
  return undefined;
}

/** Read `data-nitpicker-source` off the node or its nearest ancestor carrying it. */
function sourceOf(node: Element): string | undefined {
  let el: Element | null = node;
  while (el) {
    const v = el.getAttribute(SOURCE_ATTR);
    if (v) return v;
    el = el.parentElement;
  }
  return undefined;
}

/**
 * The `resolveElement` seam implementation for React/Next. Returns only the React-derived fields;
 * `@nitpicker/core` merges these over its framework-agnostic base descriptor.
 */
export function resolveReactElement(node: Element): Partial<ElementDescriptor> {
  const out: Partial<ElementDescriptor> = {};
  try {
    const component = componentName(node);
    if (component) out.component = component;
    const source = sourceOf(node);
    if (source) out.source = source;
  } catch {
    // best-effort: never let fiber/attribute reading break the picker.
  }
  return out;
}
