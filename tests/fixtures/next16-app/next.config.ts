import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Pin Turbopack's workspace root to this fixture dir. Without it Next walks up and finds the harness
// repo's lockfile, warns about "multiple lockfiles", and may infer the wrong root — this keeps the
// fixture's dev server deterministic when run from inside the harness worktree.
const root = dirname(fileURLToPath(import.meta.url));

// Owned-build opt-in: wire the vendored dev-only source-stamp loader so host JSX carries
// `data-nitpicker-source="file:line:col"`. This lets the builder-shell element pick + inline text edit
// (Phase 3/4) surface the exact `app/pricing-card.tsx:9:7` source, exercising the full owned-build path in
// the E2E rig (the harness's default sweet spot is still no target changes at all). Dev-only; `next build`
// sets NODE_ENV=production so the stamp is off there. The one-line wiring is documented in SKILL.md.
const dev = process.env.NODE_ENV !== "production";
const loader = resolve(root, "../../../vendor/nitpicker/next/nitpicker-source-loader.cjs");

const nextConfig: NextConfig = {
  turbopack: {
    root,
    ...(dev && {
      rules: {
        "*.tsx": { loaders: [loader] },
        "*.jsx": { loaders: [loader] },
      },
    }),
  },
};

export default nextConfig;
