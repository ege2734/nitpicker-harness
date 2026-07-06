// nitpicker — one-line Next config wrapper that turns on dev-only `file:line:col` source stamping.
//
//   // next.config.ts / .mjs / .js
//   import { withNitpickerSource } from "./nitpicker/next/with-nitpicker-source.cjs";
//   export default withNitpickerSource(nextConfig);   // (nextConfig may be {} — that's fine)
//
// It composes the source-stamp loader (nitpicker-source-loader.cjs, same file for Turbopack AND webpack)
// into whatever config you pass, spreading — never clobbering — any `turbopack`/`webpack` you already
// have. The loader path is resolved from THIS file's location (`__dirname`), so it works no matter what
// cwd `next dev` runs from. Everything is gated on `NODE_ENV !== "production"`, so `next build` (which
// sets NODE_ENV=production) is returned untouched and the stamp never ships.
//
// The stamp is best-effort and self-skipping: a file it can't parse passes through unstamped, and an app
// that never wires this in still works — the element picker just reports component + selector + text +
// route instead of an exact source location.
const path = require("node:path");

const LOADER = path.join(__dirname, "nitpicker-source-loader.cjs");

/**
 * Wrap a Next config so host JSX carries `data-nitpicker-source="file:line:col"` in dev.
 * @param {Record<string, any>} [config] the app's existing Next config (defaults to {}).
 * @returns {Record<string, any>} the config, unchanged in production; source-stamped in dev.
 */
function withNitpickerSource(config = {}) {
  if (process.env.NODE_ENV === "production") return config;

  const prevTurbopack = config.turbopack || {};
  const prevWebpack = config.webpack;

  return {
    ...config,
    // Turbopack (`next dev` default in Next 15/16). Glob → loader; do NOT set `as`/`type` — the loader
    // returns tsx/jsx unchanged, so Turbopack keeps the file's native pipeline.
    turbopack: {
      ...prevTurbopack,
      rules: {
        ...(prevTurbopack.rules || {}),
        "*.tsx": { loaders: [LOADER] },
        "*.jsx": { loaders: [LOADER] },
      },
    },
    // Fallback for `next dev --webpack`. Chains any existing webpack() the app defined, then appends the
    // stamp rule. Turbopack ignores this key; webpack uses it.
    webpack(webpackConfig, context) {
      const c =
        typeof prevWebpack === "function" ? prevWebpack(webpackConfig, context) : webpackConfig;
      c.module.rules.push({ test: /\.[jt]sx$/, exclude: /node_modules/, use: [LOADER] });
      return c;
    },
  };
}

module.exports = withNitpickerSource;
module.exports.withNitpickerSource = withNitpickerSource;
module.exports.default = withNitpickerSource;
