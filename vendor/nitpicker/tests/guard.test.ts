// nitpicker — prod-mount guardrail. The invariant that matters: Nitpicker.mount() is a defense-in-depth
// backstop that refuses to build the overlay when NODE_ENV === "production" (returning a no-op handle),
// and mounts normally otherwise. This guards against a misconfigured install leaking the dev-only UI
// into a prod runtime even after the primary layout/next.config gates.
import { describe, it, expect, afterEach } from "vitest";
import { Nitpicker } from "../core";

const ORIGINAL_ENV = process.env.NODE_ENV;

afterEach(() => {
  // Restore NODE_ENV and strip any overlay host so tests stay isolated/deterministic.
  process.env.NODE_ENV = ORIGINAL_ENV;
  document.querySelectorAll('[data-nitpicker="root"]').forEach((n) => n.remove());
});

describe("Nitpicker.mount prod guard", () => {
  it("refuses to mount in production — no DOM host, no-op handle", () => {
    process.env.NODE_ENV = "production";
    const before = document.body.childNodes.length;

    const handle = Nitpicker.mount({ session: "t" });

    // Nothing was appended, and no overlay host exists.
    expect(document.body.childNodes.length).toBe(before);
    expect(document.querySelector('[data-nitpicker="root"]')).toBeNull();
    // Still satisfies NitpickerHandle: an object with a callable unmount().
    expect(typeof handle.unmount).toBe("function");
    expect(() => handle.unmount()).not.toThrow();
  });

  it("mounts normally outside production — appends the overlay host", () => {
    process.env.NODE_ENV = "development";

    const handle = Nitpicker.mount({ session: "t" });

    // overlay.ts sets data-nitpicker="root" on the host it appends to document.body.
    const host = document.querySelector('[data-nitpicker="root"]');
    expect(host).not.toBeNull();
    expect(host?.parentNode).toBe(document.body);

    // unmount() tears the host back out.
    handle.unmount();
    expect(document.querySelector('[data-nitpicker="root"]')).toBeNull();
  });
});
