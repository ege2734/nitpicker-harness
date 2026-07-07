import { defineConfig } from "vitest/config";

// Two test trees:
//   • tests/**          — the harness's own units (proxy HTML injection + header relaxation)
//   • vendor/nitpicker/tests/** — the reused nitpicker core units (selector, red-box math, React glue,
//     sidecar drain), carried over verbatim to prove the copied code still behaves after vendoring.
//
// jsdom globally: the DOM-facing units drive fake element/canvas/fiber objects, and the node sidecar
// unit only touches node:events (available under the jsdom env). html2canvas-pro is a dependency so
// core/region.ts's dynamic import resolves at transform time; no unit executes that path.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "vendor/nitpicker/tests/**/*.test.ts"],
    globals: false,
  },
});
