// nitpicker-harness — a tiny, dependency-light markdown → DOM renderer for the builder chat's agent replies.
// SAFE BY CONSTRUCTION: every node is built with createElement + textContent (never innerHTML), and link
// hrefs are scheme-checked, so untrusted agent output can't inject HTML/scripts. STREAM-SAFE: it re-parses
// the whole accumulated string on each token, and partial/unterminated constructs (an open ``` fence, a
// half-typed `**bold`) degrade to sensible output instead of throwing or flickering into broken markup.
//
// Supported: ATX headings, bold (**), italic (*), inline code (`), fenced code blocks (``` / ~~~), ordered +
// unordered lists, links, blockquotes, horizontal rules, paragraphs with soft line breaks. Emphasis uses ONLY
// `*`/`**` (NOT `_`) so file paths / identifiers like `file_line_col` are never mangled.

// Only these URL schemes (and relative/anchor URLs) get a live href; anything else (e.g. javascript:) renders
// as inert text.
const SAFE_URL = /^(https?:|mailto:|\/|#|\.)/i;
const FENCE = /^(```+|~~~+)(.*)$/;
const FENCE_CLOSE = /^(```+|~~~+)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*([-*_])\s*(\1\s*){2,}$/;
const QUOTE = /^\s*>\s?/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Clear `root` and render `md` into it as safe DOM. Used for both streaming (re-render per token) and
 *  one-shot (history) messages. */
export function renderMarkdownInto(root: HTMLElement, md: string): void {
  root.textContent = "";
  for (const node of parseBlocks(md)) root.appendChild(node);
}

/** Parse a markdown string into a flat list of block-level DOM nodes. Pure (given a `document`); testable. */
export function parseBlocks(md: string): Node[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: Node[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code block — accumulate raw until the closing fence (or EOF while streaming).
    const fence = line.match(FENCE);
    if (fence) {
      const lang = fence[2].trim();
      i++;
      const code: string[] = [];
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++; // consume the closing fence if present
      const pre = document.createElement("pre");
      const c = document.createElement("code");
      if (lang) c.className = `language-${lang}`;
      c.textContent = code.join("\n");
      pre.appendChild(c);
      out.push(pre);
      continue;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      const el = document.createElement(`h${h[1].length}`);
      appendInline(el, h[2].trim());
      out.push(el);
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push(document.createElement("hr"));
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE, ""));
      const bq = document.createElement("blockquote");
      for (const node of parseBlocks(quoted.join("\n"))) bq.appendChild(node);
      out.push(bq);
      continue;
    }

    const first = line.match(LIST);
    if (first) {
      const ordered = /\d/.test(first[2]);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const m = lines[i].match(LIST);
        if (!m) break;
        const li = document.createElement("li");
        appendInline(li, m[3]);
        list.appendChild(li);
        i++;
      }
      out.push(list);
      continue;
    }

    // paragraph — group until a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !LIST.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    const p = document.createElement("p");
    para.forEach((l, idx) => {
      if (idx > 0) p.appendChild(document.createElement("br"));
      appendInline(p, l);
    });
    out.push(p);
  }
  return out;
}

// Earliest of: `code` | **bold** | *italic* | [text](url). Emphasis is `*`-only (never `_`).
const INLINE = /(`+)([\s\S]*?)\1|\*\*(.+?)\*\*|\*([^*]+?)\*|\[([^\]]*)\]\(([^)\s]+)\)/;

/** Parse inline markup within one text run, appending text/inline nodes to `el`. */
function appendInline(el: HTMLElement, text: string): void {
  let rest = text;
  // Bound the loop defensively; each iteration consumes at least one char of `rest`.
  while (rest.length) {
    const m = rest.match(INLINE);
    if (!m || m.index === undefined) {
      el.appendChild(document.createTextNode(rest));
      return;
    }
    if (m.index > 0) el.appendChild(document.createTextNode(rest.slice(0, m.index)));
    if (m[1] !== undefined) {
      const code = document.createElement("code");
      code.textContent = m[2];
      el.appendChild(code);
    } else if (m[3] !== undefined) {
      const strong = document.createElement("strong");
      appendInline(strong, m[3]);
      el.appendChild(strong);
    } else if (m[4] !== undefined) {
      const em = document.createElement("em");
      appendInline(em, m[4]);
      el.appendChild(em);
    } else {
      const a = document.createElement("a");
      a.textContent = m[5] ?? "";
      const url = m[6] ?? "";
      if (SAFE_URL.test(url)) {
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      el.appendChild(a);
    }
    rest = rest.slice(m.index + m[0].length);
  }
}
