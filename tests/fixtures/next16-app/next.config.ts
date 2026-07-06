import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Pin Turbopack's workspace root to this fixture dir. Without it Next walks up and finds the harness
// repo's lockfile, warns about "multiple lockfiles", and may infer the wrong root — this keeps the
// fixture's dev server deterministic when run from inside the harness worktree.
const nextConfig: NextConfig = {
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
};

export default nextConfig;
