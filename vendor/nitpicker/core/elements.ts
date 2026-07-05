// @nitpicker/core — framework-agnostic element descriptor. This is the fallback the `resolveElement` host
// seam builds on: core supplies selector/testid/text/tag/role/rect; the host (the React glue) enriches
// it with component name + source. The descriptor is agent-grade *without* any React info — selector +
// testid + text + role + route are enough for an agent to grep the code.
import type { ElementDescriptor, Rect } from "./types";

/** Attributes we treat as stable test hooks, most-preferred first. */
const TESTID_ATTRS = ["data-testid", "data-test", "data-test-id"] as const;

/** CSS.escape is a browser global; fall back to a minimal escaper so this module also runs in the
 *  DOM-less unit-test/node context (the selector logic is what we test). */
function cssEscape(s: string): string {
  const g = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (g?.escape) return g.escape(s);
  return s.replace(/[^\w-]/g, (c) => `\\${c}`);
}

/** An `id` is only worth anchoring on if it looks author-written, not framework-generated. React's
 *  `useId` (`:r0:`), Radix/Headless, and Emotion emit volatile ids that change every render/reload. */
export function isStableId(id: string): boolean {
  if (!id || id.length > 50) return false;
  if (id.includes(":")) return false; // React useId / Radix (`:r0:`, `radix-:r3:`)
  if (/^[0-9]/.test(id)) return false; // numeric / hash-leading ids are rarely author-stable
  return /^[A-Za-z][\w-]*$/.test(id);
}

/** A class is usable in a selector only if it's a plain author class (not a utility with `:` / `/`
 *  separators, not a CSS-module / Emotion content hash) AND unique among same-tag siblings so the
 *  selector still resolves to one node. Otherwise we fall back to `:nth-of-type`. */
export function stableClass(node: Element): string | undefined {
  const raw = node.getAttribute("class");
  if (!raw) return undefined;
  const parent = node.parentElement;
  for (const c of raw.trim().split(/\s+/)) {
    if (!/^[A-Za-z][\w-]*$/.test(c)) continue; // utilities (sm:px-2, hover:…) & escapes out
    if (c.length > 30 || c.length < 3) continue;
    if (/-\d+$/.test(c)) continue; // tailwind-ish sizing utilities (px-2, mt-4)
    if (/(?:__|_|-)?[a-z0-9]{5,}$/i.test(c) && /\d/.test(c)) continue; // hashy tail (Foo_ab3cd)
    if (parent) {
      const sameTagWithClass = Array.from(parent.children).filter(
        (ch) =>
          ch.tagName === node.tagName && (ch.getAttribute("class") || "").split(/\s+/).includes(c),
      );
      if (sameTagWithClass.length !== 1) continue; // ambiguous — skip
    }
    return c;
  }
  return undefined;
}

/** First present test hook (`data-testid`/`data-test`/`data-test-id`) on this node, as attr+value. */
function testidOf(node: Element): { attr: string; value: string } | undefined {
  for (const attr of TESTID_ATTRS) {
    const value = node.getAttribute(attr);
    if (value) return { attr, value };
  }
  return undefined;
}

/**
 * A short, mostly-stable CSS path (≤5 levels). Per level, prefer (in order): a stable `id` (unique →
 * stop), a test hook (`tag[data-testid="…"]` → stop), a stable+unique class (`tag.name`), else the
 * positional `tag:nth-of-type(n)`. Testid/id anchors truncate the path so the result stays greppable
 * rather than a brittle full ancestor chain.
 */
export function cssSelector(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && depth < 5 && node.nodeType === 1; depth++) {
    const tag = node.tagName.toLowerCase();

    if (node.id && isStableId(node.id)) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break; // an id is unique enough — stop climbing
    }

    const testid = testidOf(node);
    if (testid) {
      parts.unshift(`${tag}[${testid.attr}="${testid.value.replace(/"/g, '\\"')}"]`);
      break; // a test hook is meant to be unique — stop climbing
    }

    let part = tag;
    const cls = stableClass(node);
    if (cls) {
      part += `.${cssEscape(cls)}`;
    } else {
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

/** Nearest test hook value on the element or an ancestor — stable + greppable. */
export function nearestTestid(el: Element): string | undefined {
  let node: Element | null = el;
  while (node) {
    const hit = testidOf(node);
    if (hit) return hit.value;
    node = node.parentElement;
  }
  return undefined;
}

/** Visible text for grepping (≤240 chars). Prefer rendered `innerText`; fall back to `textContent`,
 *  then to accessible-name attributes (`aria-label`/`title`) when the node has no text of its own. */
export function visibleText(el: Element): string | undefined {
  const rendered = (el as HTMLElement).innerText ?? el.textContent ?? "";
  const trimmed = rendered.replace(/\s+/g, " ").trim();
  if (trimmed) return trimmed.slice(0, 240);
  const label = el.getAttribute("aria-label") || el.getAttribute("title");
  return label ? label.trim().slice(0, 240) : undefined;
}

/** Build the framework-agnostic descriptor for a picked element. */
export function baseDescriptor(el: Element): ElementDescriptor {
  const r = el.getBoundingClientRect();
  const rect: Rect = {
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
  return {
    testid: nearestTestid(el),
    selector: cssSelector(el),
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") ?? undefined,
    text: visibleText(el),
    rect,
  };
}
