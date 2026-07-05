// @nitpicker/core — public entry. Framework-agnostic overlay; mount it from any page.
//
//   import { Nitpicker } from "./core";
//   const overlay = Nitpicker.mount({ session: "my-app" });
//   // …later: overlay.unmount();
import { Overlay } from "./overlay";
import type { NitpickerHandle, NitpickerOptions } from "./types";

export const Nitpicker = {
  mount(options: NitpickerOptions): NitpickerHandle {
    // Defense-in-depth prod backstop. The PRIMARY prod gates live in the caller: the root layout only
    // renders <NitpickerOverlay/> behind `process.env.NODE_ENV !== "production"`, and the dynamic import()
    // sits inside the same static guard so webpack tree-shakes core + html2canvas out of the prod
    // bundle entirely. This runtime check is the belt to that suspenders — it does NOT replace those
    // gates (by the time this runs, the dev-only code has already shipped), it just refuses to actually
    // build the overlay if a misconfigured install slips through.
    //
    // The `typeof process` probe is mandatory: core is framework-agnostic and may run in a plain
    // browser with no bundler `process` define, where a bare `process.env` reference throws
    // ReferenceError. Under Next/webpack `process.env.NODE_ENV` is statically inlined, so this also
    // dead-code-eliminates cleanly in a prod build.
    if (typeof process !== "undefined" && process.env && process.env.NODE_ENV === "production") {
      console.warn(
        "[nitpicker] refusing to mount in production — nitpicker is a dev-only tool and must never ship to prod. Ensure it is gated behind NODE_ENV !== 'production'.",
      );
      // No-op handle: satisfies NitpickerHandle, never constructs Overlay (so no DOM host, no listeners).
      return { unmount() {} };
    }
    return new Overlay(options);
  },
};

export type { NitpickerOptions, NitpickerHandle, QueueItem, ElementDescriptor } from "./types";
