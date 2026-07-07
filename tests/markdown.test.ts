// The builder chat's tiny markdown → safe DOM renderer. Verifies the supported constructs, XSS safety
// (no raw HTML injection, scheme-checked links), and stream-safety (unterminated fence/emphasis). jsdom env.
import { describe, it, expect, beforeEach } from "vitest";
import { renderMarkdownInto } from "../src/builder/markdown";

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
});
function md(s: string): HTMLElement {
  renderMarkdownInto(root, s);
  return root;
}

describe("renderMarkdownInto", () => {
  it("renders bold, italic and inline code", () => {
    md("This is **bold**, *italic* and `code`.");
    expect(root.querySelector("strong")!.textContent).toBe("bold");
    expect(root.querySelector("em")!.textContent).toBe("italic");
    expect(root.querySelector("code")!.textContent).toBe("code");
  });

  it("renders ATX headings", () => {
    md("# H1\n## H2\n### H3");
    expect(root.querySelector("h1")!.textContent).toBe("H1");
    expect(root.querySelector("h2")!.textContent).toBe("H2");
    expect(root.querySelector("h3")!.textContent).toBe("H3");
  });

  it("renders unordered and ordered lists", () => {
    md("- a\n- b\n\n1. one\n2. two");
    expect(root.querySelector("ul")!.querySelectorAll("li")).toHaveLength(2);
    const ol = root.querySelector("ol")!;
    expect(ol.querySelectorAll("li")).toHaveLength(2);
    expect(ol.querySelector("li")!.textContent).toBe("one");
  });

  it("renders a fenced code block verbatim (no inline parsing inside)", () => {
    md("```ts\nconst x = `**not bold**`;\n```");
    const pre = root.querySelector("pre code") as HTMLElement;
    expect(pre).not.toBeNull();
    expect(pre.className).toContain("language-ts");
    expect(pre.textContent).toBe("const x = `**not bold**`;");
    expect(pre.querySelector("strong")).toBeNull();
  });

  it("does NOT keep the file path mangled by underscores (emphasis is *-only)", () => {
    md("see `src/a_b_c.ts` and file_line_col");
    // no <em> from the underscores
    expect(root.querySelector("em")).toBeNull();
    expect(root.textContent).toContain("file_line_col");
  });

  it("renders links only for safe schemes; javascript: is inert text", () => {
    md("[ok](https://example.com) and [bad](javascript:alert(1))");
    const links = root.querySelectorAll("a");
    expect(links[0].getAttribute("href")).toBe("https://example.com");
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[1].getAttribute("href")).toBeNull(); // unsafe scheme → no href
    expect(links[1].textContent).toBe("bad");
  });

  it("never injects raw HTML (angle brackets are text)", () => {
    md("<img src=x onerror=alert(1)> and <b>hi</b>");
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("is stream-safe: an unterminated code fence still renders a code block", () => {
    md("intro\n```js\nconsole.log(1)"); // no closing fence (mid-stream)
    const pre = root.querySelector("pre code");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe("console.log(1)");
  });

  it("is stream-safe: half-typed **bold renders as literal text, not broken markup", () => {
    md("this is **bol");
    expect(root.querySelector("strong")).toBeNull();
    expect(root.textContent).toContain("**bol");
  });

  it("renders blockquotes and paragraphs with soft line breaks", () => {
    md("> quoted line\n\nline one\nline two");
    expect(root.querySelector("blockquote")!.textContent).toContain("quoted line");
    const p = root.querySelectorAll("p");
    const last = p[p.length - 1];
    expect(last.querySelector("br")).not.toBeNull();
    expect(last.textContent).toContain("line one");
    expect(last.textContent).toContain("line two");
  });

  it("clears prior content on re-render (streaming replaces, not appends)", () => {
    md("first");
    md("second");
    expect(root.querySelectorAll("p")).toHaveLength(1);
    expect(root.textContent).toBe("second");
  });
});
