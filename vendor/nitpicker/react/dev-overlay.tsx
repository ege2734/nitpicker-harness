"use client";

// Dev-only mount for the @nitpicker/core feedback overlay. Two layers of prod-gating:
//  1. your root layout renders <NitpickerOverlay/> only behind `process.env.NODE_ENV !== "production"`.
//  2. the dynamic import() below sits INSIDE a `process.env.NODE_ENV !== "production"` block, which
//     Next's webpack folds to `if (false) { … }` in a prod build and eliminates — so the async chunk
//     carrying core + html2canvas is never emitted (verify with `grep -r html2canvas .next/static`).
// The early `import()` (rather than a static import) also keeps the overlay's weight out of the
// initial page bundle even in dev.
import { useEffect } from "react";

// The sidecar session id. Keep it stable per app so a running `nitpicker poll --session <id>` matches.
// Override per-deploy with NEXT_PUBLIC_NITPICKER_SESSION; defaults to "nitpicker" for a single-app setup.
const SESSION = process.env.NEXT_PUBLIC_NITPICKER_SESSION || "nitpicker";

export function NitpickerOverlay() {
  useEffect(() => {
    // The static `!== "production"` guard is what lets webpack drop this whole branch — and the
    // import() chunk with it — from the production build. Do not turn it into a runtime-only check.
    if (process.env.NODE_ENV !== "production") {
      let handle: { unmount(): void } | null = null;
      let cancelled = false;
      // Both imports sit inside this static guard so webpack drops them (core + html2canvas + the
      // React-source glue) from the prod bundle. The glue supplies the `resolveElement` seam so
      // @nitpicker/core enriches picked elements with the React component name + source file:line.
      void Promise.all([import("../core"), import("./react-source")]).then(
        ([{ Nitpicker }, { resolveReactElement }]) => {
          if (cancelled) return;
          handle = Nitpicker.mount({
            session: SESSION,
            endpoint: process.env.NEXT_PUBLIC_NITPICKER_ENDPOINT || "http://127.0.0.1:5178",
            resolveElement: resolveReactElement,
          });
        },
      );
      return () => {
        cancelled = true;
        handle?.unmount();
      };
    }
  }, []);

  return null;
}
