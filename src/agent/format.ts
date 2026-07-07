// nitpicker-harness — marks → prompt formatting (hz-agent §3.3). PURE + unit-tested (tests/gateway.test.ts).
//
// The Agent Gateway turns a turn's `{ text, marks }` into the backend's input so backends stay dumb: they
// receive a single composed prompt string plus the local paths of any region screenshots. This is the SAME
// structured descriptor the external `poll` agent gets today (SKILL.md) — only the delivery differs.
//
//   • element   → `picked <Component> at `file:line:col` (selector `…`, text "…") on route /pricing`
//   • region    → an image reference line (the red-boxed PNG's local `path`) + selection rect + route
//   • text-edit → `change text at `file:line:col` from "Old" to "New"`
//   • message   → the note verbatim, with route/pageUrl for context
import type { AgentInput, WireItem } from "./backend";

/** A backend-ready turn: a single human-readable prompt plus the local image paths to attach (region PNGs
 *  already written to the sidecar `/blob` store; the embedded agent runs on the same machine and opens them
 *  directly). */
export interface FormattedTurn {
  prompt: string;
  /** Local filesystem paths of region screenshots, in mark order. */
  imagePaths: string[];
}

/** Compose the whole turn. The user's typed note leads; each mark becomes a context block below it. */
export function formatTurn(input: AgentInput): FormattedTurn {
  const parts: string[] = [];
  const typed = (input.text ?? "").trim();
  if (typed) parts.push(typed);

  const marks = input.marks ?? [];
  const imagePaths: string[] = [];
  const markLines: string[] = [];
  for (const m of marks) {
    const line = formatMark(m);
    if (line) markLines.push(line);
    if (m.kind === "region" && m.image?.path) imagePaths.push(m.image.path);
  }
  if (markLines.length) {
    parts.push(
      `Context — ${markLines.length} mark${markLines.length === 1 ? "" : "s"} from the preview:\n` +
        markLines.map((l) => `- ${l}`).join("\n"),
    );
  }
  return { prompt: parts.join("\n\n"), imagePaths };
}

/** Format one mark into a single context line. Exported for direct unit testing. Returns "" for a mark
 *  that carries no usable descriptor (defensive; every real mark yields a line). */
export function formatMark(m: WireItem): string {
  const onRoute = m.route ? ` on route ${m.route}` : "";
  const note = m.text?.trim() ? ` — note: "${m.text.trim()}"` : "";
  switch (m.kind) {
    case "element": {
      const el = m.element ?? {};
      const who = el.component ? `<${el.component}>` : (el.tag ?? "element");
      const at = el.source ? ` at \`${el.source}\`` : "";
      const bits: string[] = [];
      if (el.selector) bits.push(`selector \`${el.selector}\``);
      if (el.testid) bits.push(`testid \`${el.testid}\``);
      if (el.text) bits.push(`text "${truncate(el.text, 80)}"`);
      const detail = bits.length ? ` (${bits.join(", ")})` : "";
      return `picked ${who}${at}${detail}${onRoute}${note}`;
    }
    case "text-edit": {
      const el = m.element ?? {};
      const at = el.source ? ` at \`${el.source}\`` : el.selector ? ` at selector \`${el.selector}\`` : "";
      return `change text${at} from "${m.oldText ?? ""}" to "${m.newText ?? ""}"${onRoute}${note}`;
    }
    case "region": {
      const rect = m.image?.selectionRect;
      const where = rect ? ` (selection ${rect.w}×${rect.h} at ${rect.x},${rect.y})` : "";
      const path = m.image?.path ? ` — screenshot: ${m.image.path}` : "";
      return `region screenshot with a red box${where}${path}${onRoute}${note}`;
    }
    case "message":
    default:
      return `${m.text?.trim() || "(empty note)"}${onRoute}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
