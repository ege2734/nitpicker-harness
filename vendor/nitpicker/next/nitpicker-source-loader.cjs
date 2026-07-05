// nitpicker — dev-only bundler loader that runs nitpicker-source-plugin over app `.tsx`/`.jsx`. A plain
// webpack-style loader so the SAME file works under both Turbopack (`turbopack.rules`) and webpack
// (`config.module.rules`) — see next.config, which only wires it in when NODE_ENV !== production.
// Best-effort: a file that fails to parse passes through unstamped rather than breaking the dev build.
const plugin = require("./nitpicker-source-plugin.cjs");

// @babel/core is loaded via dynamic import() rather than require() so this CJS loader works with BOTH
// the CJS 7.x and the ESM-only 8.x releases (8.x's `require()` throws "ES Module not supported"). The
// promise is cached so we import once, not per file.
let babelPromise;
function loadBabel() {
  if (!babelPromise) {
    babelPromise = import("@babel/core").then((m) => m.default ?? m);
  }
  return babelPromise;
}

module.exports = function nitpickerSourceLoader(source, inputMap, meta) {
  const callback = this.async();
  const filename = this.resourcePath || "";
  const root = this.rootContext || process.cwd();

  // Only stamp app JSX; never touch dependencies.
  if (!/\.[jt]sx$/.test(filename) || filename.includes("node_modules")) {
    callback(null, source, inputMap, meta);
    return;
  }

  loadBabel()
    .then((babel) =>
      babel.transformAsync(source, {
        filename,
        root,
        cwd: root,
        configFile: false,
        babelrc: false,
        compact: false,
        sourceType: "module",
        sourceMaps: true,
        inputSourceMap: inputMap || undefined,
        // Parse (but preserve) TS + JSX — no presets, so types pass through untouched to the bundler's
        // own compiler; we only append attributes.
        parserOpts: { plugins: ["jsx", "typescript"] },
        generatorOpts: { retainLines: true },
        plugins: [plugin],
      }),
    )
    .then((result) => callback(null, result.code, result.map || inputMap, meta))
    .catch((err) => {
      console.warn(`[nitpicker] source-stamp skipped ${filename}: ${err.message}`);
      callback(null, source, inputMap, meta);
    });
};
