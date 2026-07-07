// Harness-local delta (see vendor/nitpicker/README.md): the icon-font capture fix. Region capture rasterizes
// a DIFFERENT document (the proxied iframe) than the one html2canvas draws in, so a self-hosted icon webfont
// declared only in the iframe was never in the drawing document → every glyph rasterized as a tofu box (□).
// embedFontsForCapture reads the SOURCE document's @font-face rules and LOADS them into the DRAWING document
// before capture. These unit tests guard that cross-document wiring (the exact thing that was broken). The
// end-to-end visual proof is the browser repro under tests/fixtures/icon-capture (see its README).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { collectFontFaceSpecs, embedFontsForCapture } from "../core/region";

/** A fake CSSFontFaceRule (type 5) with a getPropertyValue-style descriptor bag. */
function fontFaceRule(desc: Record<string, string>) {
  return { type: 5, style: { getPropertyValue: (k: string) => desc[k] ?? "" } };
}
/** A fake @media grouping rule (type 4) nesting other rules. */
function groupRule(...rules: unknown[]) {
  return { type: 4, cssRules: rules };
}
function fakeDoc(sheets: unknown[]): Document {
  return { styleSheets: sheets } as unknown as Document;
}

describe("collectFontFaceSpecs", () => {
  it("extracts family/weight/style + the first non-data url, made absolute", () => {
    const doc = fakeDoc([
      {
        cssRules: [
          fontFaceRule({
            "font-family": '"NHIcons"',
            "font-weight": "400",
            "font-style": "normal",
            src: 'url("./icons/phosphor.woff2") format("woff2")',
          }),
        ],
      },
    ]);
    const specs = collectFontFaceSpecs(doc, "http://harness.local/app/index.html");
    expect(specs).toEqual([
      { family: "NHIcons", weight: "400", style: "normal", url: "http://harness.local/app/icons/phosphor.woff2" },
    ]);
  });

  it("skips a cross-origin stylesheet whose cssRules throws (SecurityError)", () => {
    const doc = fakeDoc([
      {
        get cssRules(): never {
          throw new DOMException("blocked", "SecurityError");
        },
      },
      { cssRules: [fontFaceRule({ "font-family": "Ok", src: 'url("/f.woff2")' })] },
    ]);
    const specs = collectFontFaceSpecs(doc, "http://h/");
    expect(specs.map((s) => s.family)).toEqual(["Ok"]);
  });

  it("finds @font-face nested inside an @media / @supports group", () => {
    const doc = fakeDoc([
      { cssRules: [groupRule(fontFaceRule({ "font-family": "Nested", src: 'url("/n.woff2")' }))] },
    ]);
    expect(collectFontFaceSpecs(doc, "http://h/").map((s) => s.family)).toEqual(["Nested"]);
  });

  it("ignores a data: URI src (nothing to fetch)", () => {
    const doc = fakeDoc([{ cssRules: [fontFaceRule({ "font-family": "D", src: "url(data:font/woff2;base64,AAA)" })] }]);
    expect(collectFontFaceSpecs(doc, "http://h/")).toEqual([]);
  });
});

describe("embedFontsForCapture (cross-document)", () => {
  let added: unknown[];
  let deleted: unknown[];
  let targetDoc: Document;

  beforeEach(() => {
    added = [];
    deleted = [];
    targetDoc = { fonts: { add: (f: unknown) => added.push(f), delete: (f: unknown) => deleted.push(f) } } as unknown as Document;
    // Stub the browser globals the embed uses (absent/partial in jsdom).
    vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })));
    class FakeFontFace {
      constructor(public family: string, public source: unknown, public descriptors: unknown) {}
      load = vi.fn(async () => this);
    }
    vi.stubGlobal("FontFace", FakeFontFace as unknown as typeof FontFace);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads the SOURCE doc's @font-face into the TARGET (drawing) doc, then cleanup removes it", async () => {
    const sourceDoc = fakeDoc([
      { cssRules: [fontFaceRule({ "font-family": "NHIcons", "font-weight": "400", src: 'url("/icons.woff2")' })] },
    ]);
    const cleanup = await embedFontsForCapture(sourceDoc, "http://h/", targetDoc);

    expect(fetch).toHaveBeenCalledWith("http://h/icons.woff2", { credentials: "same-origin" });
    expect(added).toHaveLength(1);
    expect((added[0] as { family: string }).family).toBe("NHIcons");
    expect(deleted).toHaveLength(0);

    cleanup();
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toBe(added[0]);
  });

  it("is a no-op (never throws) when FontFace is unavailable", async () => {
    vi.stubGlobal("FontFace", undefined);
    const sourceDoc = fakeDoc([{ cssRules: [fontFaceRule({ "font-family": "X", src: 'url("/x.woff2")' })] }]);
    const cleanup = await embedFontsForCapture(sourceDoc, "http://h/", targetDoc);
    expect(added).toHaveLength(0);
    expect(() => cleanup()).not.toThrow();
  });

  it("skips a font that fails to fetch, without failing the whole capture", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network");
    }));
    const sourceDoc = fakeDoc([{ cssRules: [fontFaceRule({ "font-family": "X", src: 'url("/x.woff2")' })] }]);
    const cleanup = await embedFontsForCapture(sourceDoc, "http://h/", targetDoc);
    expect(added).toHaveLength(0);
    expect(() => cleanup()).not.toThrow();
  });
});
