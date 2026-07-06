// @vitest-environment node
// Confirms the dev-only source-stamp Babel plugin + webpack-style loader (vendor/nitpicker/next/) still
// produce `data-nitpicker-source="file:line:col"` on host JSX. This is the build-time half of Phase-3
// `file:line` provenance — the runtime read is covered by vendor/nitpicker/tests/react-source.test.ts.
// The loader is bundler-agnostic (the SAME .cjs is wired under Turbopack `turbopack.rules` and webpack
// `module.rules`), so exercising it with a faked loader context proves both paths' stamping.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// @babel/core ships no bundled types; require it (untyped) rather than pull in @types/babel__core.
const babel = require("@babel/core") as {
  transformSync: (code: string, opts: unknown) => { code?: string } | null;
};
const plugin = require("../vendor/nitpicker/next/nitpicker-source-plugin.cjs");
const loader = require("../vendor/nitpicker/next/nitpicker-source-loader.cjs");

const ROOT = "/app";

function stamp(code: string, filename = `${ROOT}/pricing-card.tsx`): string {
  const out = babel.transformSync(code, {
    filename,
    root: ROOT,
    cwd: ROOT,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["jsx", "typescript"] },
    plugins: [plugin],
  });
  return out?.code ?? "";
}

describe("nitpicker-source-plugin", () => {
  it("stamps every host tag with data-nitpicker-source=file:line:col", () => {
    const code = ['export function Card() {', "  return <div className=\"card\" />;", "}"].join("\n");
    // <div> opens on line 2, column 9 (0-indexed 9) → +1 = 10.
    expect(stamp(code)).toContain('data-nitpicker-source="pricing-card.tsx:2:10"');
  });

  it("skips component tags (only the fiber walk needs those) and namespaced/member tags", () => {
    // <Foo>/<Foo.Bar> are component/member tags (fiber walk handles those); <svg:rect> is a
    // JSXNamespacedName — none are bare lowercase host identifiers, so none get stamped.
    const out = stamp("export const X = () => <Foo><Foo.Bar/><svg:rect/></Foo>;");
    const stamps = out.match(/data-nitpicker-source=/g) ?? [];
    expect(stamps.length).toBe(0);
  });

  it("does not double-stamp a tag that already carries the attribute", () => {
    const code = 'const X = () => <div data-nitpicker-source="hand.tsx:1:1" />;';
    const stamps = stamp(code).match(/data-nitpicker-source=/g) ?? [];
    expect(stamps.length).toBe(1);
  });

  it("uses a POSIX relative path from the project root", () => {
    const out = stamp("const X = () => <span/>;", `${ROOT}/app/nested/thing.tsx`);
    expect(out).toContain('data-nitpicker-source="app/nested/thing.tsx:1:17"');
  });
});

/** Minimal fake of the webpack loader `this` context the .cjs loader reads. */
function runLoader(
  source: string,
  resourcePath: string,
): Promise<{ code: string; err: Error | null }> {
  return new Promise((resolve) => {
    const ctx = {
      resourcePath,
      rootContext: ROOT,
      async() {
        return (err: Error | null, code?: string) => resolve({ code: code ?? "", err });
      },
    };
    loader.call(ctx, source, undefined, undefined);
  });
}

describe("nitpicker-source-loader (bundler-agnostic wrapper)", () => {
  it("stamps app .tsx via the plugin", async () => {
    const { code, err } = await runLoader(
      "const X = () => <button/>;",
      `${ROOT}/app/pricing-card.tsx`,
    );
    expect(err).toBeNull();
    expect(code).toContain('data-nitpicker-source="app/pricing-card.tsx:1:17"');
  });

  it("passes node_modules through untouched (never stamps dependencies)", async () => {
    const src = "const X = () => <div/>;";
    const { code, err } = await runLoader(src, `${ROOT}/node_modules/pkg/index.tsx`);
    expect(err).toBeNull();
    expect(code).toBe(src);
  });

  it("passes non-JSX extensions through untouched", async () => {
    const src = "export const x = 1;";
    const { code, err } = await runLoader(src, `${ROOT}/app/util.ts`);
    expect(err).toBeNull();
    expect(code).toBe(src);
  });
});
